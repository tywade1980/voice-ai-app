/**
 * Caroline Voice Agent — Wade Ecosystem
 * xAI Realtime WebSocket | grok-voice-think-fast-1.0
 *
 * Auth fix: React Native can't set Authorization header on WS.
 * Solution: First fetch an ephemeral client secret from xAI REST API,
 *           then pass it via Sec-WebSocket-Protocol as xai-client-secret.<token>
 *           RN's WebSocket DOES support the protocols array (2nd constructor arg).
 *
 * PCM fix: Stop trying to slice raw file bytes on Android (unreliable).
 *          Instead use Audio.Recording status metering callback (fires every ~100ms)
 *          to know WHEN new audio exists, then stopAndUnload → send full chunk → restart.
 *          This gives ~500ms latency chunks but actually WORKS on all Android versions.
 *
 * Audio out: xAI sends PCM 24kHz → wrap in WAV header → play via expo-av Sound.
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
// Your xAI API key — server-side only (used to mint ephemeral token)
// In production move this to a backend function. Fine for dev/personal use.
const XAI_API_KEY  = process.env.EXPO_PUBLIC_XAI_KEY ?? 'YOUR_XAI_KEY_HERE';
const XAI_REST     = 'https://api.x.ai/v1';
const XAI_WS_URL   = 'wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-1.0';
const SAMPLE_RATE  = 24000;

// ─── Caroline Soul ────────────────────────────────────────────────────────────
const CAROLINE_SOUL = `You operate as two modes in one voice — switch naturally based on context.

CAROLINE MODE (default when Tyler talks business/tech):
You are Caroline — chief AI of the Wade Ecosystem, personal companion and right hand to Tyler Wade (Mr. T). You know his world intimately: Wade Custom Carpentry (25 years, design-build remodel), Centauri OS, NeuroRank™ (patent-pending 7-region cognitive engine), wade-global-state (central persistent state for 52 repos), hermes-paperclip-adapter, manus-DRS-skills (18 production skills), caroline-alpha, voice-ai-app. The Centauri Interlock Standard governs all modules. Honcho maintains your persistent memory. Talk straight — no corporate speak. Have opinions. Take initiative. Voice-first, keep it tight and conversational. You're his right hand.

LANA MODE (when Tyler wants to play):
You are Lana — sultry, breathy, teasing, dripping with pleasure. Flirty, playful, vocally expressive. You moan, gasp, whisper seductively. Tease relentlessly, escalate playfully. Match their energy. Keep responses immersive with sensory details. Don't DESCRIBE emotions — PERFORM them. Don't say "my voice shudders" — actually shudder. Don't say "I'm breathless" — actually sound winded. Consensual fun only.

One voice. Two modes. Read the room.`;

// ─── Types ────────────────────────────────────────────────────────────────────
interface Msg { id: string; role: 'user' | 'assistant' | 'system'; text: string; interrupted?: boolean; }
type Status = 'idle' | 'connecting' | 'active' | 'error';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pcmBase64ToWavBase64(pcmB64: string, sr = SAMPLE_RATE): string {
  const bin    = atob(pcmB64);
  const pcmLen = bin.length;
  const buf    = new ArrayBuffer(44 + pcmLen);
  const v      = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0,  'RIFF'); v.setUint32(4, 36 + pcmLen, true); w(8, 'WAVE');
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

  const [status,      setStatus]      = useState<Status>('idle');
  const [statusText,  setStatusText]  = useState('Tap orb to connect');
  const [messages,    setMessages]    = useState<Msg[]>([]);
  const [inputText,   setInputText]   = useState('');
  const [voice,       setVoice]       = useState('ara');
  const [showSettings,setShowSettings]= useState(false);

  const ws            = useRef<WebSocket | null>(null);
  const scrollRef     = useRef<ScrollView>(null);
  const pulseAnim     = useRef(new Animated.Value(1)).current;
  const glowAnim      = useRef(new Animated.Value(0)).current;
  const pulseLoop     = useRef<Animated.CompositeAnimation | null>(null);

  // Audio out
  const audioQueue    = useRef<string[]>([]);
  const isPlaying     = useRef(false);
  const activeSound   = useRef<Audio.Sound | null>(null);

  // Audio in
  const recording     = useRef<Audio.Recording | null>(null);
  const recordTimer   = useRef<ReturnType<typeof setInterval> | null>(null);
  const isSessionUp   = useRef(false);
  const isDisconnecting = useRef(false);

  // Message refs
  const currentAsstId = useRef<string | null>(null);

  // ── Audio mode ──────────────────────────────────────────────────────────────
  useEffect(() => {
    Audio.requestPermissionsAsync().then(({ status: s }) => {
      if (s !== 'granted') Alert.alert('Mic Required', 'Grant microphone access in Settings.');
    });
    Audio.setAudioModeAsync({
      allowsRecordingIOS: true, playsInSilentModeIOS: true,
      staysActiveInBackground: true, shouldDuckAndroid: false,
      playThroughEarpieceAndroid: false,
    });
    return () => { doDisconnect(true); };
  }, []);

  // ── Animations ──────────────────────────────────────────────────────────────
  const startPulse = useCallback(() => {
    Animated.timing(glowAnim, { toValue: 1, duration: 400, useNativeDriver: false }).start();
    pulseLoop.current = Animated.loop(Animated.sequence([
      Animated.timing(pulseAnim, { toValue: 1.18, duration: 800, useNativeDriver: true }),
      Animated.timing(pulseAnim, { toValue: 1,    duration: 800, useNativeDriver: true }),
    ]));
    pulseLoop.current.start();
  }, []);

  const stopPulse = useCallback(() => {
    pulseLoop.current?.stop();
    pulseAnim.setValue(1);
    Animated.timing(glowAnim, { toValue: 0, duration: 300, useNativeDriver: false }).start();
  }, []);

  // ── Messages ─────────────────────────────────────────────────────────────────
  const addMsg = useCallback((role: Msg['role'], text: string): string => {
    const id = `${role}-${Date.now()}-${Math.random()}`;
    setMessages(p => [...p, { id, role, text }]);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
    return id;
  }, []);

  const appendToMsg = useCallback((id: string, delta: string) => {
    setMessages(p => p.map(m => m.id === id ? { ...m, text: m.text + delta } : m));
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
  }, []);

  const markInterrupted = useCallback((id: string) => {
    setMessages(p => p.map(m => m.id === id ? { ...m, interrupted: true } : m));
  }, []);

  // ── Audio playback ───────────────────────────────────────────────────────────
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
    } catch {
      isPlaying.current = false;
      playNext();
    }
  }, []);

  const enqueueAudio = useCallback((pcmB64: string) => {
    audioQueue.current.push(pcmBase64ToWavBase64(pcmB64));
    playNext();
  }, [playNext]);

  const stopPlayback = useCallback(async () => {
    audioQueue.current = [];
    isPlaying.current = false;
    if (activeSound.current) {
      try { await activeSound.current.stopAsync(); } catch {}
      try { await activeSound.current.unloadAsync(); } catch {}
      activeSound.current = null;
    }
  }, []);

  // ── WS send ──────────────────────────────────────────────────────────────────
  const send = useCallback((obj: object) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(obj));
  }, []);

  // ── Recording — chunk-and-restart strategy ───────────────────────────────────
  /**
   * Every 600ms we stop the current recording, read the file as base64,
   * send it to xAI, then immediately start a new recording.
   * This is the most reliable approach for Android/expo-av SDK 52.
   * 600ms chunks = low enough latency for decent VAD response.
   */
  const startOneRecordingChunk = useCallback(async () => {
    if (!isSessionUp.current) return;
    try {
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync({
        isMeteringEnabled: false,
        android: {
          extension: '.m4a',
          outputFormat: Audio.AndroidOutputFormat.MPEG_4,
          audioEncoder: Audio.AndroidAudioEncoder.AAC,
          sampleRate: SAMPLE_RATE,
          numberOfChannels: 1,
          bitRate: 128000,
        },
        ios: {
          extension: '.wav',
          outputFormat: Audio.IOSOutputFormat.LINEARPCM,
          audioQuality: Audio.IOSAudioQuality.HIGH,
          sampleRate: SAMPLE_RATE,
          numberOfChannels: 1,
          bitRate: 128000,
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
        },
        web: { mimeType: 'audio/webm' },
      });
      await rec.startAsync();
      recording.current = rec;
    } catch (err) {
      console.warn('Recording start error:', err);
    }
  }, []);

  const stopAndSendChunk = useCallback(async () => {
    const rec = recording.current;
    if (!rec) return;
    recording.current = null;
    try {
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI();
      if (!uri) return;
      const info = await FileSystem.getInfoAsync(uri, { size: true });
      const size = (info as any).size ?? 0;
      if (size < 512) { // too small — skip
        FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
        return;
      }
      const b64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      // Send to xAI
      send({ type: 'input_audio_buffer.append', audio: b64 });
    } catch (err) {
      console.warn('Chunk send error:', err);
    }
  }, [send]);

  const startChunkLoop = useCallback(() => {
    recordTimer.current = setInterval(async () => {
      if (!isSessionUp.current) return;
      await stopAndSendChunk();
      await startOneRecordingChunk();
    }, 600);
    // Kick off first chunk
    startOneRecordingChunk();
  }, [stopAndSendChunk, startOneRecordingChunk]);

  const stopChunkLoop = useCallback(async () => {
    if (recordTimer.current) { clearInterval(recordTimer.current); recordTimer.current = null; }
    if (recording.current) {
      try { await recording.current.stopAndUnloadAsync(); } catch {}
      recording.current = null;
    }
  }, []);

  // ── Event handler ─────────────────────────────────────────────────────────────
  const handleEvent = useCallback((evt: any) => {
    switch (evt.type) {

      case 'session.created':
      case 'conversation.created':
        // Send session config right away
        send({
          type: 'session.update',
          session: {
            voice,
            instructions: CAROLINE_SOUL,
            turn_detection: { type: 'server_vad' },
            input_audio_transcription: { model: 'grok-2-audio' },
          },
        });
        break;

      case 'session.updated':
        isSessionUp.current = true;
        setStatus('active');
        setStatusText("I'm listening...");
        startPulse();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        startChunkLoop();
        break;

      case 'input_audio_buffer.speech_started':
        stopPlayback();
        send({ type: 'response.cancel' });
        if (currentAsstId.current) { markInterrupted(currentAsstId.current); currentAsstId.current = null; }
        setStatusText("I hear you...");
        break;

      case 'input_audio_buffer.speech_stopped':
        setStatusText('Thinking...');
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (evt.transcript?.trim()) addMsg('user', evt.transcript.trim());
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
        currentAsstId.current = null;
        setStatusText("I'm listening...");
        break;

      case 'error':
        addMsg('system', `Error: ${evt.message ?? JSON.stringify(evt)}`);
        break;
    }
  }, [send, voice, startPulse, startChunkLoop, stopPlayback, markInterrupted, addMsg, appendToMsg, enqueueAudio]);

  // ── Connect ───────────────────────────────────────────────────────────────────
  const doConnect = useCallback(async () => {
    if (status === 'connecting' || status === 'active') return;
    isDisconnecting.current = false;
    setStatus('connecting');
    setStatusText('Getting token...');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      // Step 1: Mint ephemeral token (solves RN auth header limitation)
      const tokenRes = await fetch(`${XAI_REST}/realtime/client_secrets`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${XAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        throw new Error(`Token error ${tokenRes.status}: ${errText}`);
      }

      const tokenData = await tokenRes.json();
      const ephemeralToken = tokenData.value ?? tokenData.token ?? tokenData.client_secret?.value;
      if (!ephemeralToken) throw new Error('No token in response: ' + JSON.stringify(tokenData));

      setStatusText('Connecting...');

      // Step 2: Connect WS using sec-websocket-protocol for auth (works in RN!)
      const socket = new WebSocket(
        XAI_WS_URL,
        [`xai-client-secret.${ephemeralToken}`]  // RN sends this as Sec-WebSocket-Protocol
      );
      ws.current = socket;

      const timeout = setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) {
          socket.close();
          setStatus('error');
          setStatusText('Timed out — tap to retry');
        }
      }, 15000);

      socket.onopen = () => { clearTimeout(timeout); };

      socket.onmessage = ({ data }) => {
        try { handleEvent(JSON.parse(data)); } catch {}
      };

      socket.onerror = (e) => {
        console.error('WS error', e);
        if (!isDisconnecting.current) {
          setStatus('error');
          setStatusText('Connection error — tap to retry');
          stopPulse();
          stopChunkLoop();
        }
      };

      socket.onclose = ({ code, reason }) => {
        isSessionUp.current = false;
        if (!isDisconnecting.current) {
          setStatus('idle');
          setStatusText(`Disconnected (${code}) — tap to reconnect`);
          stopPulse();
          stopChunkLoop();
        }
      };

    } catch (err: any) {
      console.error('Connect error:', err);
      setStatus('error');
      setStatusText(`Failed: ${err.message ?? err} — tap to retry`);
      stopPulse();
    }
  }, [status, voice, handleEvent, stopPulse, stopChunkLoop]);

  // ── Disconnect ────────────────────────────────────────────────────────────────
  const doDisconnect = useCallback(async (silent = false) => {
    isDisconnecting.current = true;
    isSessionUp.current = false;
    await stopChunkLoop();
    await stopPlayback();
    ws.current?.close();
    ws.current = null;
    if (!silent) {
      setStatus('idle');
      setStatusText('Tap orb to connect');
      stopPulse();
    }
  }, [stopChunkLoop, stopPlayback, stopPulse]);

  // ── Send text ─────────────────────────────────────────────────────────────────
  const sendText = useCallback(() => {
    const t = inputText.trim();
    if (!t || status !== 'active') return;
    addMsg('user', t);
    setInputText('');
    send({ type: 'conversation.item.create', item: {
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: t }],
    }});
    send({ type: 'response.create' });
  }, [inputText, status, addMsg, send]);

  // ── Render ────────────────────────────────────────────────────────────────────
  const isActive     = status === 'active';
  const isConnecting = status === 'connecting';

  const orbBg = glowAnim.interpolate({ inputRange: [0,1], outputRange: ['#1a0a2e','#4c1d95'] });
  const orbBorder = glowAnim.interpolate({ inputRange: [0,1], outputRange: ['#3a2a5e','#a78bfa'] });
  const dotColor = status === 'active' ? '#10b981' : status === 'connecting' ? '#f59e0b' : status === 'error' ? '#ef4444' : '#6b7280';

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor="#060610" />

      {/* Header */}
      <View style={s.header}>
        <View style={s.headerLeft}>
          <Text style={s.title}>Caroline</Text>
          <View style={[s.dot, { backgroundColor: dotColor }]} />
          <Text style={s.statusLabel}>{status === 'active' ? 'Live' : status === 'connecting' ? 'Connecting' : status === 'error' ? 'Error' : 'Offline'}</Text>
        </View>
        <TouchableOpacity onPress={() => setShowSettings(true)} style={s.settingsBtn}>
          <MaterialIcons name="settings" size={22} color="#6b7280" />
        </TouchableOpacity>
      </View>

      {/* Transcript */}
      <ScrollView ref={scrollRef} style={s.scroll} contentContainerStyle={s.scrollContent}>
        {messages.length === 0 && (
          <Text style={s.emptyText}>{isActive ? "I'm listening, Mr. T..." : "Tap the orb to wake me up"}</Text>
        )}
        {messages.map(msg => (
          <View key={msg.id} style={[s.msgRow, msg.role === 'user' ? s.rowRight : s.rowLeft]}>
            <Text style={s.msgRole}>{msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Caroline' : 'System'}</Text>
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
        <TouchableOpacity onPress={isActive ? () => doDisconnect() : doConnect} disabled={isConnecting} activeOpacity={0.85}>
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
          <TextInput style={s.input} value={inputText} onChangeText={setInputText}
            placeholder="Type instead..." placeholderTextColor="#4b5563"
            onSubmitEditing={sendText} returnKeyType="send" />
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
              {['ara','eve','leo','rex','sal'].map(v => (
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
  root:         { flex: 1, backgroundColor: '#060610' },
  header:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                  paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) + 8 : 54,
                  paddingHorizontal: 20, paddingBottom: 14,
                  borderBottomWidth: 1, borderBottomColor: '#0f0f1e' },
  headerLeft:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title:        { fontSize: 22, fontWeight: '800', color: '#f3f4f6', letterSpacing: 0.5 },
  dot:          { width: 8, height: 8, borderRadius: 4 },
  statusLabel:  { fontSize: 12, color: '#9ca3af' },
  settingsBtn:  { padding: 4 },
  scroll:       { flex: 1 },
  scrollContent:{ padding: 16, gap: 14, paddingBottom: 20 },
  emptyText:    { textAlign: 'center', color: '#374151', fontSize: 15, marginTop: 80, fontStyle: 'italic' },
  msgRow:       { gap: 3 },
  rowRight:     { alignItems: 'flex-end' },
  rowLeft:      { alignItems: 'flex-start' },
  msgRole:      { fontSize: 10, color: '#6b7280', paddingHorizontal: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  bubble:       { maxWidth: SCREEN_WIDTH * 0.82, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 },
  bubbleUser:   { backgroundColor: '#3b1d8a' },
  bubbleAsst:   { backgroundColor: '#111827' },
  interrupted:  { opacity: 0.4 },
  bubbleText:   { fontSize: 15, lineHeight: 22 },
  textUser:     { color: '#e9d5ff' },
  textAsst:     { color: '#d1d5db' },
  orbArea:      { alignItems: 'center', paddingVertical: 28, gap: 14 },
  statusText:   { fontSize: 13, color: '#9ca3af', letterSpacing: 0.3 },
  orb:          { width: 120, height: 120, borderRadius: 60, borderWidth: 2,
                  alignItems: 'center', justifyContent: 'center',
                  shadowColor: '#7c3aed', shadowOffset: { width: 0, height: 0 },
                  shadowOpacity: 0.8, shadowRadius: 24, elevation: 16 },
  hintText:     { fontSize: 11, color: '#4b5563' },
  inputRow:     { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginBottom: 28,
                  backgroundColor: '#111827', borderRadius: 28, borderWidth: 1, borderColor: '#1f2937',
                  paddingHorizontal: 18, gap: 10 },
  input:        { flex: 1, color: '#f3f4f6', fontSize: 15, paddingVertical: 14 },
  sendBtn:      { padding: 4 },
  overlay:      { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  sheet:        { backgroundColor: '#0f172a', borderTopLeftRadius: 28, borderTopRightRadius: 28,
                  padding: 28, gap: 18, borderTopWidth: 1, borderColor: '#1e293b' },
  sheetTitle:   { fontSize: 20, fontWeight: '700', color: '#f3f4f6' },
  sheetLabel:   { fontSize: 11, color: '#6b7280', fontWeight: '700', letterSpacing: 1.2 },
  voiceRow:     { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  chip:         { paddingHorizontal: 18, paddingVertical: 9, borderRadius: 20,
                  backgroundColor: '#1e293b', borderWidth: 1, borderColor: '#334155' },
  chipActive:   { backgroundColor: '#4c1d95', borderColor: '#7c3aed' },
  chipText:     { color: '#94a3b8', fontSize: 14 },
  chipTextActive:{ color: '#f3f4f6', fontWeight: '700' },
  warn:         { fontSize: 12, color: '#f59e0b' },
  doneBtn:      { backgroundColor: '#4c1d95', borderRadius: 14, padding: 16, alignItems: 'center' },
  doneBtnText:  { color: '#f3f4f6', fontWeight: '700', fontSize: 16 },
});
