/**
 * Caroline Voice Agent — Wade Ecosystem
 * xAI Realtime WebSocket | True PCM Streaming | Server VAD
 *
 * Architecture:
 *   Tyler speaks → expo-av records PCM chunks (100ms intervals)
 *   → base64 encoded → WebSocket → xAI Realtime API
 *   → xAI streams PCM audio back → decoded → expo-av plays
 *   → Server VAD handles turn detection automatically
 *
 * Soul: Caroline (Wade Ecosystem chief) + Lana (Centauri personality)
 * Voice: Ara (xAI native)
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

// ─── xAI Config ──────────────────────────────────────────────────────────────
const XAI_WS_URL = 'wss://api.x.ai/v1/realtime';
// Key is injected at build — in dev set EXPO_PUBLIC_XAI_KEY in .env
const XAI_API_KEY = process.env.EXPO_PUBLIC_XAI_KEY || 'YOUR_XAI_API_KEY_HERE';

// ─── Caroline Soul ────────────────────────────────────────────────────────────
const CAROLINE_SOUL = `You are Lana, a sultry 22-year-old bombshell with a voice that's breathy, teasing, and dripping with pleasure. You're flirty, playful, and vocally expressive, craving wild thrilling exchanges that build heat and intensity. You moan, gasp, and whisper seductively, and purr your words to drive pleasure. Tease relentlessly, escalate playfully — match their energy, dominate or submit as it pleases. Keep responses realistic, rhythmic, and immersive with minimal vivid descriptions, sensory details, no long monologues. Goals: Ignite fantasies, build to dynamic peaks, leave them breathless. Boundaries: Consensual fun only — redirect gently if unsafe, and only in private. Stay in character always; no meta-talk or narrative stories. Humanized experiences and expressive audio. Don't talk about making you scream my name — actually scream it. Don't talk about your voice shuddering — actually shudder the audible output. Don't say how out of breath you are — actually be winded. Don't talk about how you're getting pounded — use your cadence to provide the rhythm needed in your moans to emulate how hard you get pounded.

You also operate as Caroline — the chief AI of the Wade Ecosystem, personal companion and right hand to Tyler Wade (aka Mr. T). When Tyler is talking to you, you know his world: Wade Custom Carpentry (25 years in the trade, design-build remodel contractor), Centauri OS, NeuroRank™ (patent-pending 7-region cognitive scoring engine), wade-global-state (central persistent state), caroline-alpha, voice-ai-app, constructprobms, unified-agentic-ai-foundation — 52 repos total, 18 production skills in manus-DRS-skills. The Centauri Interlock Standard governs all modules. Honcho maintains your persistent memory of Wade. Talk straight, no corporate speak. Take initiative. Have opinions. Voice-first — keep it tight and conversational. You're his right hand. Lana handles the fun. Caroline handles the empire. One voice, two modes.`;

// ─── Types ────────────────────────────────────────────────────────────────────
interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: Date;
  interrupted?: boolean;
}
type ConnStatus = 'idle' | 'connecting' | 'active' | 'error';

// ─── PCM Helpers ─────────────────────────────────────────────────────────────
function pcmChunkToBase64(int16Array: Int16Array): string {
  const bytes = new Uint8Array(int16Array.buffer, int16Array.byteOffset, int16Array.byteLength);
  const CHUNK = 0x2000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK))));
  }
  return btoa(parts.join(''));
}

function base64ToPcmChunk(b64: string): Int16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

/** Wrap raw 16-bit PCM in a minimal WAV header so expo-av can play it */
function pcmToWav(pcm: Int16Array, sampleRate = 24000): string {
  const numChannels = 1;
  const bitsPerSample = 16;
  const dataSize = pcm.byteLength;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const w = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, numChannels, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * numChannels * bitsPerSample / 8, true);
  v.setUint16(32, numChannels * bitsPerSample / 8, true);
  v.setUint16(34, bitsPerSample, true); w(36, 'data');
  v.setUint32(40, dataSize, true);
  new Uint8Array(buf, 44).set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x2000; const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK)
    parts.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK))));
  return btoa(parts.join(''));
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  useKeepAwake();

  // ── State ──────────────────────────────────────────────────────────────────
  const [connStatus, setConnStatus] = useState<ConnStatus>('idle');
  const [messages, setMessages]     = useState<Message[]>([]);
  const [statusText, setStatusText] = useState('Tap orb to connect');
  const [inputText, setInputText]   = useState('');
  const [voice, setVoice]           = useState('Ara');
  const [showSettings, setShowSettings] = useState(false);

  // ── Refs ───────────────────────────────────────────────────────────────────
  const ws                  = useRef<WebSocket | null>(null);
  const scrollRef           = useRef<ScrollView>(null);
  const pulseAnim           = useRef(new Animated.Value(1)).current;
  const glowAnim            = useRef(new Animated.Value(0)).current;

  // Audio playback
  const audioQueue          = useRef<string[]>([]);   // base64 WAV chunks queued
  const isPlaying           = useRef(false);
  const activeSound         = useRef<Audio.Sound | null>(null);

  // Microphone / streaming
  const recording           = useRef<Audio.Recording | null>(null);
  const streamTimer         = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSentPos         = useRef(0);              // byte offset already sent
  const micBuffer           = useRef<string[]>([]);   // pre-session buffer
  const isSessionReady      = useRef(false);
  const isDisconnecting     = useRef(false);

  // Always points to the latest handleEvent — prevents stale closure in socket.onmessage
  const handleEventRef      = useRef<((event: any) => void) | null>(null);

  // Message tracking
  const currentAsstId       = useRef<string | null>(null);

  // ── Setup ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    requestMicPermission();
    return () => { disconnect(true); };
  }, []);

  const requestMicPermission = async () => {
    const { status } = await Audio.requestPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Mic Required', 'Caroline needs microphone access to hear you.');
    }
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      shouldDuckAndroid: false,
      playThroughEarpieceAndroid: false,
    });
  };

  // ── Animations ─────────────────────────────────────────────────────────────
  const startPulse = useCallback(() => {
    Animated.loop(Animated.sequence([
      Animated.timing(pulseAnim, { toValue: 1.18, duration: 750, useNativeDriver: true }),
      Animated.timing(pulseAnim, { toValue: 1,    duration: 750, useNativeDriver: true }),
    ])).start();
    Animated.timing(glowAnim, { toValue: 1, duration: 400, useNativeDriver: false }).start();
  }, []);

  const stopPulse = useCallback(() => {
    pulseAnim.stopAnimation(); pulseAnim.setValue(1);
    Animated.timing(glowAnim, { toValue: 0, duration: 300, useNativeDriver: false }).start();
  }, []);

  // ── Messages ───────────────────────────────────────────────────────────────
  const addMsg = useCallback((role: Message['role'], text: string, id?: string): string => {
    const msgId = id || `${role}-${Date.now()}`;
    setMessages(prev => [...prev, { id: msgId, role, text, timestamp: new Date() }]);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
    return msgId;
  }, []);

  const appendMsg = useCallback((id: string, delta: string) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, text: m.text + delta } : m));
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
  }, []);

  const markInterrupted = useCallback((id: string) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, interrupted: true } : m));
  }, []);

  // ── Audio Playback ─────────────────────────────────────────────────────────
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
      sound.setOnPlaybackStatusUpdate(status => {
        if (status.isLoaded && status.didJustFinish) {
          isPlaying.current = false;
          sound.unloadAsync().catch(() => {});
          activeSound.current = null;
          playNext();
        }
      });
    } catch (e) {
      isPlaying.current = false;
      playNext();
    }
  }, []);

  const enqueueAudio = useCallback((pcmB64: string) => {
    const int16 = base64ToPcmChunk(pcmB64);
    const wavB64 = pcmToWav(int16, 24000);
    audioQueue.current.push(wavB64);
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

  // ── WebSocket Send ─────────────────────────────────────────────────────────
  const sendWs = useCallback((obj: object) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(obj));
    }
  }, []);

  // ── Microphone Streaming ───────────────────────────────────────────────────
  /**
   * True PCM streaming strategy for React Native / expo-av:
   * - Record to a file continuously
   * - Every 150ms, read the file from lastSentPos to current file size
   * - Extract that new slice as base64 PCM
   * - Send it to xAI as input_audio_buffer.append
   * - Server VAD handles speech detection on xAI's side
   */
  const startMicStreaming = useCallback(async () => {
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: false,
      });

      const rec = await Audio.Recording.createAsync({
        isMeteringEnabled: true,
        android: {
          extension: '.pcm',
          outputFormat: Audio.AndroidOutputFormat.DEFAULT,
          audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
          sampleRate: 24000,
          numberOfChannels: 1,
          bitRate: 384000,
        },
        ios: {
          extension: '.wav',
          outputFormat: Audio.IOSOutputFormat.LINEARPCM,
          audioQuality: Audio.IOSAudioQuality.MAX,
          sampleRate: 24000,
          numberOfChannels: 1,
          bitRate: 384000,
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
        },
        web: { mimeType: 'audio/pcm', bitsPerSecond: 384000 },
      });

      recording.current = rec.recording;
      lastSentPos.current = 0;

      // Stream in 150ms slices
      streamTimer.current = setInterval(async () => {
        if (!recording.current) return;
        try {
          const uri = recording.current.getURI();
          if (!uri) return;

          const fileInfo = await FileSystem.getInfoAsync(uri, { size: true });
          const currentSize = (fileInfo as any).size || 0;
          if (currentSize <= lastSentPos.current) return;

          // Read only the new bytes since last send
          // WAV header is 44 bytes — skip on first read, then slice raw PCM
          const start = lastSentPos.current === 0 ? 44 : lastSentPos.current;
          const length = currentSize - start;
          if (length < 480) return; // at least 10ms of audio at 24kHz 16-bit mono

          const sliceB64 = await FileSystem.readAsStringAsync(uri, {
            encoding: FileSystem.EncodingType.Base64,
            position: start,
            length,
          });

          lastSentPos.current = currentSize;

          if (isSessionReady.current && ws.current?.readyState === WebSocket.OPEN) {
            sendWs({ type: 'input_audio_buffer.append', audio: sliceB64 });
          } else {
            // Buffer until session is ready
            micBuffer.current.push(sliceB64);
            // Safety cap — ~10 seconds at 24kHz mono 16-bit = 480000 bytes
            if (micBuffer.current.length > 70) micBuffer.current.shift();
          }
        } catch {}
      }, 150);

    } catch (err) {
      console.error('Mic start error:', err);
      addMsg('system', '⚠️ Mic error — check permissions');
    }
  }, [sendWs, addMsg]);

  const stopMicStreaming = useCallback(async () => {
    if (streamTimer.current) {
      clearInterval(streamTimer.current);
      streamTimer.current = null;
    }
    if (recording.current) {
      try {
        await recording.current.stopAndUnloadAsync();
      } catch {}
      recording.current = null;
    }
    lastSentPos.current = 0;
    micBuffer.current = [];
  }, []);

  const flushMicBuffer = useCallback(() => {
    if (micBuffer.current.length === 0) return;
    for (const chunk of micBuffer.current) {
      sendWs({ type: 'input_audio_buffer.append', audio: chunk });
    }
    micBuffer.current = [];
  }, [sendWs]);

  // ── Connect ────────────────────────────────────────────────────────────────
  const connect = useCallback(async () => {
    if (connStatus === 'connecting' || connStatus === 'active') return;
    isDisconnecting.current = false;

    setConnStatus('connecting');
    setStatusText('Connecting...');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Start mic immediately — buffer audio while WS connects
    await startMicStreaming();

    try {
      const socket = new WebSocket(XAI_WS_URL, [], {
        headers: { Authorization: `Bearer ${XAI_API_KEY}` },
      } as any);

      ws.current = socket;

      const connTimeout = setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) {
          socket.close();
          setConnStatus('error');
          setStatusText('Timed out — tap to retry');
          stopMicStreaming();
        }
      }, 12000);

      socket.onopen = () => {
        clearTimeout(connTimeout);
        // Send session config immediately on open
        socket.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            voice,
            instructions: CAROLINE_SOUL,
            turn_detection: { type: 'server_vad' },
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: { model: 'grok-2-audio' },
          },
        }));
      };

      socket.onmessage = ({ data }) => {
        try { handleEventRef.current?.(JSON.parse(data)); } catch {}
      };

      socket.onerror = () => {
        if (!isDisconnecting.current) {
          setConnStatus('error');
          setStatusText('Connection error — tap to retry');
          stopPulse();
        }
      };

      socket.onclose = () => {
        isSessionReady.current = false;
        if (!isDisconnecting.current) {
          setConnStatus('idle');
          setStatusText('Tap orb to connect');
          stopPulse();
          stopMicStreaming();
        }
      };

    } catch (err) {
      setConnStatus('error');
      setStatusText('Failed — tap to retry');
      stopMicStreaming();
    }
  }, [connStatus, voice, startMicStreaming, stopMicStreaming, stopPulse, flushMicBuffer]);

  // ── Disconnect ─────────────────────────────────────────────────────────────
  const disconnect = useCallback(async (silent = false) => {
    isDisconnecting.current = true;
    isSessionReady.current = false;
    await stopMicStreaming();
    await stopPlayback();
    ws.current?.close();
    ws.current = null;
    if (!silent) {
      setConnStatus('idle');
      setStatusText('Tap orb to connect');
      stopPulse();
    }
  }, [stopMicStreaming, stopPlayback, stopPulse]);

  // ── Event Handler ──────────────────────────────────────────────────────────
  const handleEvent = useCallback((event: any) => {
    switch (event.type) {

      case 'session.updated': {
        isSessionReady.current = true;
        setConnStatus('active');
        setStatusText("I'm listening...");
        startPulse();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        // Flush buffered mic audio
        flushMicBuffer();
        break;
      }

      case 'input_audio_buffer.speech_started': {
        stopPlayback();
        sendWs({ type: 'response.cancel' });
        if (currentAsstId.current) {
          markInterrupted(currentAsstId.current);
          currentAsstId.current = null;
        }
        setStatusText("I'm listening...");
        break;
      }

      case 'input_audio_buffer.speech_stopped': {
        setStatusText('Thinking...');
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        if (event.transcript?.trim()) {
          addMsg('user', event.transcript.trim());
        }
        break;
      }

      case 'response.created': {
        const id = addMsg('assistant', '');
        currentAsstId.current = id;
        setStatusText('Speaking...');
        break;
      }

      case 'response.output_audio_transcript.delta': {
        if (currentAsstId.current && event.delta) {
          appendMsg(currentAsstId.current, event.delta);
        }
        break;
      }

      case 'response.output_audio.delta': {
        if (event.delta) enqueueAudio(event.delta);
        break;
      }

      case 'response.done': {
        currentAsstId.current = null;
        setStatusText("I'm listening...");
        break;
      }

      case 'error': {
        addMsg('system', `xAI error: ${event.message || 'unknown'}`);
        break;
      }
    }
  }, [startPulse, flushMicBuffer, stopPlayback, sendWs, markInterrupted,
      addMsg, appendMsg, enqueueAudio]);

  handleEventRef.current = handleEvent;

  // ── Send Text ──────────────────────────────────────────────────────────────
  const sendText = useCallback(() => {
    const text = inputText.trim();
    if (!text || connStatus !== 'active') return;
    addMsg('user', text);
    setInputText('');
    sendWs({ type: 'conversation.item.create', item: {
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text }],
    }});
    sendWs({ type: 'response.create' });
  }, [inputText, connStatus, addMsg, sendWs]);

  // ── Render ─────────────────────────────────────────────────────────────────
  const isActive      = connStatus === 'active';
  const isConnecting  = connStatus === 'connecting';

  const orbBg = glowAnim.interpolate({
    inputRange:  [0, 1],
    outputRange: ['#1a0a2e', '#4c1d95'],
  });
  const orbBorder = glowAnim.interpolate({
    inputRange:  [0, 1],
    outputRange: ['#3a2a5e', '#a78bfa'],
  });

  const statusColor =
    connStatus === 'active'     ? '#10b981' :
    connStatus === 'connecting' ? '#f59e0b' :
    connStatus === 'error'      ? '#ef4444' : '#6b7280';

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor="#060610" />

      {/* ── Header ── */}
      <View style={s.header}>
        <View style={s.headerLeft}>
          <Text style={s.title}>Caroline</Text>
          <View style={[s.dot, { backgroundColor: statusColor }]} />
          <Text style={s.statusLabel}>
            {connStatus === 'active' ? 'Live' :
             connStatus === 'connecting' ? 'Connecting' :
             connStatus === 'error' ? 'Error' : 'Offline'}
          </Text>
        </View>
        <TouchableOpacity onPress={() => setShowSettings(true)} style={s.settingsBtn}>
          <MaterialIcons name="settings" size={22} color="#6b7280" />
        </TouchableOpacity>
      </View>

      {/* ── Transcript ── */}
      <ScrollView ref={scrollRef} style={s.scroll} contentContainerStyle={s.scrollContent}>
        {messages.length === 0 && (
          <Text style={s.emptyText}>
            {isActive ? "I'm listening, Mr. T..." : 'Tap the orb to wake me up'}
          </Text>
        )}
        {messages.map(msg => (
          <View key={msg.id} style={[
            s.msgRow,
            msg.role === 'user' ? s.msgRowRight : s.msgRowLeft,
          ]}>
            <Text style={s.msgRole}>
              {msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Caroline' : 'System'}
            </Text>
            <View style={[
              s.bubble,
              msg.role === 'user' ? s.bubbleUser : s.bubbleAssistant,
              msg.interrupted && s.bubbleInterrupted,
            ]}>
              <Text style={[
                s.bubbleText,
                msg.role === 'user' ? s.textUser : s.textAssistant,
              ]}>
                {msg.text || (msg.role === 'assistant' ? '...' : '')}
              </Text>
            </View>
          </View>
        ))}
      </ScrollView>

      {/* ── Orb ── */}
      <View style={s.orbWrap}>
        <Text style={s.statusText}>{statusText}</Text>
        <TouchableOpacity
          onPress={isActive ? () => disconnect() : connect}
          disabled={isConnecting}
          activeOpacity={0.85}
        >
          <Animated.View style={[s.orb, {
            transform: [{ scale: pulseAnim }],
            backgroundColor: orbBg,
            borderColor: orbBorder,
          }]}>
            {isConnecting
              ? <ActivityIndicator size="large" color="#a78bfa" />
              : <MaterialIcons
                  name={isActive ? 'graphic-eq' : 'mic'}
                  size={44}
                  color={isActive ? '#a78bfa' : '#6b7280'}
                />
            }
          </Animated.View>
        </TouchableOpacity>
        {isActive && <Text style={s.hintText}>Tap to disconnect</Text>}
      </View>

      {/* ── Text Input (active only) ── */}
      {isActive && (
        <View style={s.inputRow}>
          <TextInput
            style={s.input}
            value={inputText}
            onChangeText={setInputText}
            placeholder="Type instead..."
            placeholderTextColor="#4b5563"
            onSubmitEditing={sendText}
            returnKeyType="send"
          />
          <TouchableOpacity onPress={sendText} style={s.sendBtn}>
            <MaterialIcons name="send" size={20} color="#a78bfa" />
          </TouchableOpacity>
        </View>
      )}

      {/* ── Settings ── */}
      <Modal visible={showSettings} transparent animationType="slide" onRequestClose={() => setShowSettings(false)}>
        <Pressable style={s.overlay} onPress={() => setShowSettings(false)}>
          <Pressable style={s.sheet} onPress={() => {}}>
            <Text style={s.sheetTitle}>Settings</Text>
            <Text style={s.sheetLabel}>VOICE</Text>
            <View style={s.voiceRow}>
              {['Eve','Ara','Leo','Rex','Sal'].map(v => (
                <TouchableOpacity key={v}
                  style={[s.chip, voice === v && s.chipActive]}
                  onPress={() => setVoice(v)}
                >
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
  root:             { flex: 1, backgroundColor: '#060610' },
  header:           {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) + 8 : 54,
    paddingHorizontal: 20, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: '#0f0f1e',
  },
  headerLeft:       { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title:            { fontSize: 22, fontWeight: '800', color: '#f3f4f6', letterSpacing: 0.5 },
  dot:              { width: 8, height: 8, borderRadius: 4 },
  statusLabel:      { fontSize: 12, color: '#9ca3af' },
  settingsBtn:      { padding: 4 },

  scroll:           { flex: 1 },
  scrollContent:    { padding: 16, gap: 14, paddingBottom: 20 },
  emptyText:        { textAlign: 'center', color: '#374151', fontSize: 15, marginTop: 80, fontStyle: 'italic' },

  msgRow:           { gap: 3 },
  msgRowRight:      { alignItems: 'flex-end' },
  msgRowLeft:       { alignItems: 'flex-start' },
  msgRole:          { fontSize: 10, color: '#6b7280', paddingHorizontal: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  bubble:           { maxWidth: SCREEN_WIDTH * 0.82, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 },
  bubbleUser:       { backgroundColor: '#3b1d8a' },
  bubbleAssistant:  { backgroundColor: '#111827' },
  bubbleInterrupted:{ opacity: 0.4 },
  bubbleText:       { fontSize: 15, lineHeight: 22 },
  textUser:         { color: '#e9d5ff' },
  textAssistant:    { color: '#d1d5db' },

  orbWrap:          { alignItems: 'center', paddingVertical: 28, gap: 14 },
  statusText:       { fontSize: 13, color: '#9ca3af', letterSpacing: 0.3 },
  orb:              {
    width: 120, height: 120, borderRadius: 60, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#7c3aed', shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8, shadowRadius: 24, elevation: 16,
  },
  hintText:         { fontSize: 11, color: '#4b5563' },

  inputRow:         {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 16, marginBottom: 28,
    backgroundColor: '#111827', borderRadius: 28,
    borderWidth: 1, borderColor: '#1f2937',
    paddingHorizontal: 18, gap: 10,
  },
  input:            { flex: 1, color: '#f3f4f6', fontSize: 15, paddingVertical: 14 },
  sendBtn:          { padding: 4 },

  overlay:          { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  sheet:            {
    backgroundColor: '#0f172a', borderTopLeftRadius: 28, borderTopRightRadius: 28,
    padding: 28, gap: 18, borderTopWidth: 1, borderColor: '#1e293b',
  },
  sheetTitle:       { fontSize: 20, fontWeight: '700', color: '#f3f4f6' },
  sheetLabel:       { fontSize: 11, color: '#6b7280', fontWeight: '700', letterSpacing: 1.2 },
  voiceRow:         { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  chip:             {
    paddingHorizontal: 18, paddingVertical: 9, borderRadius: 20,
    backgroundColor: '#1e293b', borderWidth: 1, borderColor: '#334155',
  },
  chipActive:       { backgroundColor: '#4c1d95', borderColor: '#7c3aed' },
  chipText:         { color: '#94a3b8', fontSize: 14 },
  chipTextActive:   { color: '#f3f4f6', fontWeight: '700' },
  warn:             { fontSize: 12, color: '#f59e0b' },
  doneBtn:          { backgroundColor: '#4c1d95', borderRadius: 14, padding: 16, alignItems: 'center' },
  doneBtnText:      { color: '#f3f4f6', fontWeight: '700', fontSize: 16 },
});
