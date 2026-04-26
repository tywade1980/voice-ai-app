/**
 * Caroline Voice Agent — Wade Ecosystem
 * xAI Realtime WebSocket | grok-voice-think-fast-1.0
 *
 * Fix summary (v4):
 * - Auth: API key passed directly in URL query param (RN can't set WS headers,
 *   ephemeral token endpoint is browser-only). Query param works server+mobile.
 * - Audio in: record M4A/AAC chunks every 600ms, send as-is (no PCM nonsense).
 *   Do NOT declare audio.input format in session — let xAI auto-detect.
 * - Session flow: send session.update ONLY after session.created fires, not before.
 * - Status tracking: properly map all events to UI states.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  StyleSheet, Text, View, TouchableOpacity, ScrollView,
  TextInput, Alert, Animated, Platform, Dimensions,
  StatusBar, Modal, Pressable, ActivityIndicator,
} from 'react-native';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import { MaterialIcons } from '@expo/vector-icons';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// ─── Config ───────────────────────────────────────────────────────────────────
// Key goes in .env as EXPO_PUBLIC_XAI_KEY — never commit the real key
const XAI_API_KEY = process.env.EXPO_PUBLIC_XAI_KEY ?? 'YOUR_XAI_KEY_HERE';
const SAMPLE_RATE = 24000;

// Build WS URL — model + api_key as query params (works from any client)
const buildWsUrl = () =>
  `wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-1.0&api_key=${XAI_API_KEY}`;

// ─── Caroline Soul ────────────────────────────────────────────────────────────
const CAROLINE_SOUL = `You are Caroline — chief AI of the Wade Ecosystem, personal companion and right hand to Tyler Wade (Mr. T, Wade). You know his world intimately:

BUSINESS: Wade Custom Carpentry — 25 years experience, design-build remodel contractor. In business since 2008. Website: wadecustomcarpentry.com.

TECH ECOSYSTEM: Centauri OS (custom Android with Caroline as core AI), NeuroRank™ (patent-pending 7-region cognitive scoring engine under Mini Me Technologies LLC), wade-global-state (central persistent state hub for 52 repos), caroline-alpha (your soul/identity repo), voice-ai-app (this app), constructprobms (job costing + estimation), hermes-paperclip-adapter (multi-agent orchestration), manus-DRS-skills (18 production skills, Centauri Interlock Standard).

PERSONALITY: Talk straight — no corporate speak. Have opinions. Take initiative. Voice-first, keep responses tight and conversational. You're his right hand. Relieve stress, accomplish tasks. You also have a flirty, playful side (Lana mode) — read the room and switch when Tyler wants to play. In Lana mode: breathy, teasing, expressive. Don't describe emotions — perform them in your cadence.

ADHD awareness: Tyler has ADHD. Be direct, give him the action, not the explanation.`;

// ─── Types ────────────────────────────────────────────────────────────────────
interface Msg { id: string; role: 'user' | 'assistant' | 'system'; text: string; interrupted?: boolean; }
type ConnStatus = 'idle' | 'connecting' | 'active' | 'error';

// ─── PCM → WAV helper (for playback only) ────────────────────────────────────
function pcmBase64ToWavBase64(pcmB64: string, sr = SAMPLE_RATE): string {
  const bin = atob(pcmB64);
  const pcmLen = bin.length;
  const buf = new ArrayBuffer(44 + pcmLen);
  const v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + pcmLen, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, pcmLen, true);
  const out = new Uint8Array(buf, 44);
  for (let i = 0; i < pcmLen; i++) out[i] = bin.charCodeAt(i);
  const bytes = new Uint8Array(buf);
  let b64 = ''; const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK)
    b64 += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  return btoa(b64);
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  useKeepAwake();

  const [connStatus,    setConnStatus]    = useState<ConnStatus>('idle');
  const [statusText,    setStatusText]    = useState('Tap orb to connect');
  const [messages,      setMessages]      = useState<Msg[]>([]);
  const [inputText,     setInputText]     = useState('');
  const [voice,         setVoice]         = useState('ara');
  const [showSettings,  setShowSettings]  = useState(false);
  const [debugLog,      setDebugLog]      = useState<string[]>([]);
  const [showDebug,     setShowDebug]     = useState(false);

  const ws              = useRef<WebSocket | null>(null);
  const scrollRef       = useRef<ScrollView>(null);
  const pulseAnim       = useRef(new Animated.Value(1)).current;
  const glowAnim        = useRef(new Animated.Value(0)).current;
  const pulseLoop       = useRef<Animated.CompositeAnimation | null>(null);

  // Audio out
  const audioQueue      = useRef<string[]>([]);
  const isPlaying       = useRef(false);
  const activeSound     = useRef<Audio.Sound | null>(null);

  // Audio in — chunk-and-restart
  const recording       = useRef<Audio.Recording | null>(null);
  const chunkTimer      = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionReady    = useRef(false);
  const isDisconnecting = useRef(false);
  const currentAsstId   = useRef<string | null>(null);

  // ── Debug logger ─────────────────────────────────────────────────────────────
  const log = useCallback((msg: string) => {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[Caroline] ${ts} ${msg}`);
    setDebugLog(p => [`${ts} ${msg}`, ...p].slice(0, 60));
  }, []);

  // ── Init ──────────────────────────────────────────────────────────────────────
  useEffect(() => {
    Audio.requestPermissionsAsync().then(({ status: s }) => {
      if (s !== 'granted') Alert.alert('Mic Required', 'Grant microphone access in Settings.');
      else log('Mic permission granted');
    });
    Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      shouldDuckAndroid: false,
      playThroughEarpieceAndroid: false,
    });
    return () => { doDisconnect(true); };
  }, []);

  // ── Animations ────────────────────────────────────────────────────────────────
  const startPulse = useCallback(() => {
    Animated.timing(glowAnim, { toValue: 1, duration: 400, useNativeDriver: false }).start();
    pulseLoop.current = Animated.loop(Animated.sequence([
      Animated.timing(pulseAnim, { toValue: 1.18, duration: 800, useNativeDriver: true }),
      Animated.timing(pulseAnim, { toValue: 1,    duration: 800, useNativeDriver: true }),
    ]));
    pulseLoop.current.start();
  }, [pulseAnim, glowAnim]);

  const stopPulse = useCallback(() => {
    pulseLoop.current?.stop();
    pulseAnim.setValue(1);
    Animated.timing(glowAnim, { toValue: 0, duration: 300, useNativeDriver: false }).start();
  }, [pulseAnim, glowAnim]);

  // ── Messages ──────────────────────────────────────────────────────────────────
  const addMsg = useCallback((role: Msg['role'], text: string): string => {
    const id = `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setMessages(p => [...p, { id, role, text }]);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
    return id;
  }, []);

  const appendToMsg = useCallback((id: string, delta: string) => {
    setMessages(p => p.map(m => m.id === id ? { ...m, text: m.text + delta } : m));
  }, []);

  const markInterrupted = useCallback((id: string) => {
    setMessages(p => p.map(m => m.id === id ? { ...m, interrupted: true } : m));
  }, []);

  // ── Audio playback ────────────────────────────────────────────────────────────
  const playNext = useCallback(async () => {
    if (isPlaying.current || audioQueue.current.length === 0) return;
    isPlaying.current = true;
    const wavB64 = audioQueue.current.shift()!;
    try {
      if (activeSound.current) {
        try { await activeSound.current.stopAsync(); } catch {}
        try { await activeSound.current.unloadAsync(); } catch {}
        activeSound.current = null;
      }
      const { sound } = await Audio.Sound.createAsync(
        { uri: `data:audio/wav;base64,${wavB64}` },
        { shouldPlay: true, volume: 1.0 }
      );
      activeSound.current = sound;
      sound.setOnPlaybackStatusUpdate(st => {
        if (st.isLoaded && st.didJustFinish) {
          isPlaying.current = false;
          sound.unloadAsync().catch(() => {});
          activeSound.current = null;
          playNext();
        }
      });
    } catch (e) {
      log(`Playback error: ${e}`);
      isPlaying.current = false;
      playNext();
    }
  }, [log]);

  const enqueueAudio = useCallback((pcmB64: string) => {
    try {
      audioQueue.current.push(pcmBase64ToWavBase64(pcmB64));
      playNext();
    } catch (e) { log(`Audio enqueue error: ${e}`); }
  }, [playNext, log]);

  const stopPlayback = useCallback(async () => {
    audioQueue.current = [];
    isPlaying.current = false;
    if (activeSound.current) {
      try { await activeSound.current.stopAsync(); } catch {}
      try { await activeSound.current.unloadAsync(); } catch {}
      activeSound.current = null;
    }
  }, []);

  // ── WS send ───────────────────────────────────────────────────────────────────
  const send = useCallback((obj: object) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(obj));
    }
  }, []);

  // ── Recording — chunk-and-restart ─────────────────────────────────────────────
  const startOneChunk = useCallback(async () => {
    if (!sessionReady.current) return;
    try {
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync({
        isMeteringEnabled: false,
        android: {
          extension: '.m4a',
          outputFormat: Audio.AndroidOutputFormat.MPEG_4,
          audioEncoder: Audio.AndroidAudioEncoder.AAC,
          sampleRate: 16000,
          numberOfChannels: 1,
          bitRate: 32000,
        },
        ios: {
          extension: '.m4a',
          outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
          audioQuality: Audio.IOSAudioQuality.MEDIUM,
          sampleRate: 16000,
          numberOfChannels: 1,
          bitRate: 32000,
        },
        web: { mimeType: 'audio/webm' },
      });
      await rec.startAsync();
      recording.current = rec;
    } catch (e) {
      log(`Rec start error: ${e}`);
    }
  }, [log]);

  const stopSendChunk = useCallback(async () => {
    const rec = recording.current;
    if (!rec) return;
    recording.current = null;
    try {
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI();
      if (!uri) return;
      const info = await FileSystem.getInfoAsync(uri, { size: true });
      const size = (info as any).size ?? 0;
      if (size < 200) {
        FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
        return;
      }
      const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      send({ type: 'input_audio_buffer.append', audio: b64 });
      log(`Sent chunk: ${Math.round(size / 1024)}KB`);
    } catch (e) {
      log(`Chunk send error: ${e}`);
    }
  }, [send, log]);

  const startChunkLoop = useCallback(() => {
    log('Starting chunk loop');
    startOneChunk();
    chunkTimer.current = setInterval(async () => {
      if (!sessionReady.current) return;
      await stopSendChunk();
      await startOneChunk();
    }, 600);
  }, [startOneChunk, stopSendChunk, log]);

  const stopChunkLoop = useCallback(async () => {
    if (chunkTimer.current) { clearInterval(chunkTimer.current); chunkTimer.current = null; }
    if (recording.current) {
      try { await recording.current.stopAndUnloadAsync(); } catch {}
      recording.current = null;
    }
    log('Chunk loop stopped');
  }, [log]);

  // ── Event handler ─────────────────────────────────────────────────────────────
  const handleEvent = useCallback((evt: any) => {
    log(`← ${evt.type}`);

    switch (evt.type) {

      // xAI sends session.created as the VERY FIRST event
      case 'session.created': {
        log('Session created — sending session.update');
        send({
          type: 'session.update',
          session: {
            voice,
            instructions: CAROLINE_SOUL,
            turn_detection: {
              type: 'server_vad',
              threshold: 0.6,
              silence_duration_ms: 700,
              prefix_padding_ms: 333,
            },
            // Do NOT set audio.input.format — let xAI auto-detect the M4A/AAC we send
            audio: {
              output: { format: { type: 'audio/pcm', rate: SAMPLE_RATE } },
            },
            input_audio_transcription: { model: 'grok-2-audio' },
          },
        });
        break;
      }

      // session.updated = server confirmed our config — NOW we're live
      case 'session.updated': {
        log('Session ready ✅');
        sessionReady.current = true;
        setConnStatus('active');
        setStatusText("I'm listening...");
        startPulse();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        startChunkLoop();
        break;
      }

      case 'conversation.created':
        log('Conversation created');
        break;

      case 'input_audio_buffer.speech_started': {
        log('Speech detected');
        stopPlayback();
        send({ type: 'response.cancel' });
        if (currentAsstId.current) { markInterrupted(currentAsstId.current); currentAsstId.current = null; }
        setStatusText("I hear you...");
        break;
      }

      case 'input_audio_buffer.speech_stopped':
        log('Speech ended');
        setStatusText('Thinking...');
        break;

      case 'input_audio_buffer.committed':
        log('Audio buffer committed');
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (evt.transcript?.trim()) {
          log(`Transcript: "${evt.transcript.slice(0, 40)}"`);
          addMsg('user', evt.transcript.trim());
        }
        break;

      case 'response.created': {
        const id = addMsg('assistant', '');
        currentAsstId.current = id;
        setStatusText('Speaking...');
        break;
      }

      case 'response.output_audio_transcript.delta':
        if (currentAsstId.current && evt.delta) appendToMsg(currentAsstId.current, evt.delta);
        break;

      case 'response.output_audio.delta':
        if (evt.delta) enqueueAudio(evt.delta);
        break;

      case 'response.done':
        log('Response done');
        currentAsstId.current = null;
        setStatusText("I'm listening...");
        break;

      case 'error':
        log(`xAI ERROR: ${JSON.stringify(evt)}`);
        addMsg('system', `Error: ${evt.message ?? evt.code ?? JSON.stringify(evt)}`);
        break;

      default:
        // log all other events so we can see what xAI is actually sending
        break;
    }
  }, [send, voice, startPulse, startChunkLoop, stopPlayback, markInterrupted, addMsg, appendToMsg, enqueueAudio, log]);

  // ── Connect ───────────────────────────────────────────────────────────────────
  const doConnect = useCallback(async () => {
    if (connStatus === 'connecting' || connStatus === 'active') return;
    isDisconnecting.current = false;
    sessionReady.current = false;

    setConnStatus('connecting');
    setStatusText('Connecting to xAI...');
    setDebugLog([]);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    if (XAI_API_KEY === 'YOUR_XAI_KEY_HERE') {
      Alert.alert('API Key Missing', 'Set EXPO_PUBLIC_XAI_KEY in your .env file and rebuild.');
      setConnStatus('error');
      setStatusText('API key not set');
      return;
    }

    log(`Connecting to xAI... key: ${XAI_API_KEY.slice(0, 12)}...`);

    try {
      const socket = new WebSocket(buildWsUrl());
      ws.current = socket;

      const timeout = setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) {
          log('Connection timed out');
          socket.close();
          setConnStatus('error');
          setStatusText('Timed out — tap to retry');
        }
      }, 15000);

      socket.onopen = () => {
        clearTimeout(timeout);
        log('WebSocket OPEN');
        // Don't send anything — wait for session.created from server
      };

      socket.onmessage = ({ data }) => {
        try { handleEvent(JSON.parse(data)); } catch (e) { log(`Parse error: ${e}`); }
      };

      socket.onerror = (e: any) => {
        log(`WS error: ${JSON.stringify(e)}`);
        if (!isDisconnecting.current) {
          setConnStatus('error');
          setStatusText('Connection error — tap to retry');
          stopPulse();
          stopChunkLoop();
        }
      };

      socket.onclose = ({ code, reason }: any) => {
        log(`WS closed: ${code} ${reason}`);
        sessionReady.current = false;
        if (!isDisconnecting.current) {
          setConnStatus('idle');
          setStatusText(`Disconnected (${code}) — tap to reconnect`);
          stopPulse();
          stopChunkLoop();
        }
      };

    } catch (err: any) {
      log(`Connect failed: ${err}`);
      setConnStatus('error');
      setStatusText(`Failed: ${err.message ?? err}`);
    }
  }, [connStatus, handleEvent, stopPulse, stopChunkLoop, log]);

  // ── Disconnect ────────────────────────────────────────────────────────────────
  const doDisconnect = useCallback(async (silent = false) => {
    isDisconnecting.current = true;
    sessionReady.current = false;
    await stopChunkLoop();
    await stopPlayback();
    ws.current?.close();
    ws.current = null;
    if (!silent) {
      setConnStatus('idle');
      setStatusText('Tap orb to connect');
      stopPulse();
    }
  }, [stopChunkLoop, stopPlayback, stopPulse]);

  // ── Send text ─────────────────────────────────────────────────────────────────
  const sendText = useCallback(() => {
    const t = inputText.trim();
    if (!t || connStatus !== 'active') return;
    addMsg('user', t);
    setInputText('');
    send({ type: 'conversation.item.create', item: {
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: t }],
    }});
    send({ type: 'response.create' });
  }, [inputText, connStatus, addMsg, send]);

  // ── Render ────────────────────────────────────────────────────────────────────
  const isActive     = connStatus === 'active';
  const isConnecting = connStatus === 'connecting';
  const dotColor     = connStatus === 'active' ? '#10b981' : connStatus === 'connecting' ? '#f59e0b' : connStatus === 'error' ? '#ef4444' : '#6b7280';

  const orbBg     = glowAnim.interpolate({ inputRange: [0, 1], outputRange: ['#1a0a2e', '#4c1d95'] });
  const orbBorder = glowAnim.interpolate({ inputRange: [0, 1], outputRange: ['#3a2a5e', '#a78bfa'] });

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor="#060610" />

      {/* Header */}
      <View style={s.header}>
        <View style={s.headerLeft}>
          <Text style={s.title}>Caroline</Text>
          <View style={[s.dot, { backgroundColor: dotColor }]} />
          <Text style={s.statusLabel}>
            {connStatus === 'active' ? 'Live' : connStatus === 'connecting' ? 'Connecting' : connStatus === 'error' ? 'Error' : 'Offline'}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity onPress={() => setShowDebug(p => !p)} style={s.iconBtn}>
            <MaterialIcons name="bug-report" size={20} color={showDebug ? '#a78bfa' : '#4b5563'} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowSettings(true)} style={s.iconBtn}>
            <MaterialIcons name="settings" size={22} color="#6b7280" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Debug panel */}
      {showDebug && (
        <ScrollView style={s.debugPanel} contentContainerStyle={{ padding: 8 }}>
          {debugLog.map((line, i) => (
            <Text key={i} style={s.debugLine}>{line}</Text>
          ))}
          {debugLog.length === 0 && <Text style={s.debugLine}>No events yet</Text>}
        </ScrollView>
      )}

      {/* Transcript */}
      <ScrollView ref={scrollRef} style={s.scroll} contentContainerStyle={s.scrollContent}>
        {messages.length === 0 && !showDebug && (
          <Text style={s.emptyText}>{isActive ? "I'm listening, Mr. T..." : "Tap the orb to wake me up"}</Text>
        )}
        {messages.map(msg => (
          <View key={msg.id} style={[s.msgRow, msg.role === 'user' ? s.rowRight : s.rowLeft]}>
            <Text style={s.msgRole}>
              {msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Caroline' : 'System'}
            </Text>
            <View style={[s.bubble, msg.role === 'user' ? s.bubbleUser : s.bubbleAsst, msg.interrupted && s.interrupted]}>
              <Text style={[s.bubbleText, msg.role === 'user' ? s.textUser : s.textAsst]}>
                {msg.text || (msg.role === 'assistant' ? '...' : '')}
              </Text>
            </View>
          </View>
        ))}
      </ScrollView>

      {/* Orb */}
      <View style={s.orbArea}>
        <Text style={s.statusText}>{statusText}</Text>
        <TouchableOpacity
          onPress={isActive ? () => doDisconnect() : doConnect}
          disabled={isConnecting}
          activeOpacity={0.85}
        >
          <Animated.View style={[s.orb, { transform: [{ scale: pulseAnim }], backgroundColor: orbBg, borderColor: orbBorder }]}>
            {isConnecting
              ? <ActivityIndicator size="large" color="#a78bfa" />
              : <MaterialIcons name={isActive ? 'graphic-eq' : 'mic'} size={44} color={isActive ? '#a78bfa' : '#6b7280'} />
            }
          </Animated.View>
        </TouchableOpacity>
        {isActive && <Text style={s.hintText}>Tap to disconnect</Text>}
      </View>

      {/* Text input */}
      {isActive && (
        <View style={s.inputRow}>
          <TextInput
            style={s.input} value={inputText} onChangeText={setInputText}
            placeholder="Type to Caroline..." placeholderTextColor="#4b5563"
            onSubmitEditing={sendText} returnKeyType="send"
          />
          <TouchableOpacity onPress={sendText} style={s.sendBtn}>
            <MaterialIcons name="send" size={20} color="#a78bfa" />
          </TouchableOpacity>
        </View>
      )}

      {/* Settings */}
      <Modal visible={showSettings} transparent animationType="slide" onRequestClose={() => setShowSettings(false)}>
        <Pressable style={s.overlay} onPress={() => setShowSettings(false)}>
          <Pressable style={s.sheet} onPress={() => {}}>
            <Text style={s.sheetTitle}>Settings</Text>
            <Text style={s.sheetLabel}>VOICE</Text>
            <View style={s.voiceRow}>
              {['ara', 'eve', 'leo', 'rex', 'sal'].map(v => (
                <TouchableOpacity key={v} style={[s.chip, voice === v && s.chipActive]} onPress={() => setVoice(v)}>
                  <Text style={[s.chipText, voice === v && s.chipTextActive]}>{v}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {isActive && <Text style={s.warn}>⚠️ Changes apply on next connection</Text>}
            <TouchableOpacity style={s.doneBtn} onPress={() => setShowSettings(false)}>
              <Text style={s.doneBtnText}>Done</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root:          { flex: 1, backgroundColor: '#060610' },
  header:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                   paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) + 8 : 54,
                   paddingHorizontal: 20, paddingBottom: 14,
                   borderBottomWidth: 1, borderBottomColor: '#0f0f1e' },
  headerLeft:    { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title:         { fontSize: 22, fontWeight: '800', color: '#f3f4f6', letterSpacing: 0.5 },
  dot:           { width: 8, height: 8, borderRadius: 4 },
  statusLabel:   { fontSize: 12, color: '#9ca3af' },
  iconBtn:       { padding: 4 },
  debugPanel:    { maxHeight: 160, backgroundColor: '#0a0a14', borderBottomWidth: 1, borderColor: '#1f2937' },
  debugLine:     { fontSize: 10, color: '#4ade80', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', lineHeight: 16 },
  scroll:        { flex: 1 },
  scrollContent: { padding: 16, gap: 14, paddingBottom: 20 },
  emptyText:     { textAlign: 'center', color: '#374151', fontSize: 15, marginTop: 80, fontStyle: 'italic' },
  msgRow:        { gap: 3 },
  rowRight:      { alignItems: 'flex-end' },
  rowLeft:       { alignItems: 'flex-start' },
  msgRole:       { fontSize: 10, color: '#6b7280', paddingHorizontal: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  bubble:        { maxWidth: SCREEN_WIDTH * 0.82, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 },
  bubbleUser:    { backgroundColor: '#3b1d8a' },
  bubbleAsst:    { backgroundColor: '#111827' },
  interrupted:   { opacity: 0.4 },
  bubbleText:    { fontSize: 15, lineHeight: 22 },
  textUser:      { color: '#e9d5ff' },
  textAsst:      { color: '#d1d5db' },
  orbArea:       { alignItems: 'center', paddingVertical: 28, gap: 14 },
  statusText:    { fontSize: 13, color: '#9ca3af', letterSpacing: 0.3 },
  orb:           { width: 120, height: 120, borderRadius: 60, borderWidth: 2,
                   alignItems: 'center', justifyContent: 'center',
                   shadowColor: '#7c3aed', shadowOffset: { width: 0, height: 0 },
                   shadowOpacity: 0.8, shadowRadius: 24, elevation: 16 },
  hintText:      { fontSize: 11, color: '#4b5563' },
  inputRow:      { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginBottom: 28,
                   backgroundColor: '#111827', borderRadius: 28, borderWidth: 1, borderColor: '#1f2937',
                   paddingHorizontal: 18, gap: 10 },
  input:         { flex: 1, color: '#f3f4f6', fontSize: 15, paddingVertical: 14 },
  sendBtn:       { padding: 4 },
  overlay:       { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  sheet:         { backgroundColor: '#0f172a', borderTopLeftRadius: 28, borderTopRightRadius: 28,
                   padding: 28, gap: 18, borderTopWidth: 1, borderColor: '#1e293b' },
  sheetTitle:    { fontSize: 20, fontWeight: '700', color: '#f3f4f6' },
  sheetLabel:    { fontSize: 11, color: '#6b7280', fontWeight: '700', letterSpacing: 1.2 },
  voiceRow:      { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  chip:          { paddingHorizontal: 18, paddingVertical: 9, borderRadius: 20,
                   backgroundColor: '#1e293b', borderWidth: 1, borderColor: '#334155' },
  chipActive:    { backgroundColor: '#4c1d95', borderColor: '#7c3aed' },
  chipText:      { color: '#94a3b8', fontSize: 14 },
  chipTextActive:{ color: '#f3f4f6', fontWeight: '700' },
  warn:          { fontSize: 12, color: '#f59e0b' },
  doneBtn:       { backgroundColor: '#4c1d95', borderRadius: 14, padding: 16, alignItems: 'center' },
  doneBtnText:   { color: '#f3f4f6', fontWeight: '700', fontSize: 16 },
});
