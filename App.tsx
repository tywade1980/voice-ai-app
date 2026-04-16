import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Alert,
  Animated,
  Dimensions,
  StatusBar,
  Modal,
  Pressable,
  ActivityIndicator,
  AppState,
  AppStateStatus,
} from 'react-native';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import { MaterialIcons } from '@expo/vector-icons';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// ─── Config ───────────────────────────────────────────────────────────────────
// All API keys are managed server-side. The app only needs the Railway URL.
const SERVER_URL = 'https://caroline-server-v2-production.up.railway.app';

// ─── Types ────────────────────────────────────────────────────────────────────
type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
};

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'speaking' | 'error';

// ─── Caroline AI App ──────────────────────────────────────────────────────────
export default function App() {
  useKeepAwake();

  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [messages, setMessages] = useState<Message[]>([]);
  const [statusText, setStatusText] = useState('Tap to talk to Caroline');
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const appStateRef = useRef(AppState.currentState);

  // ─── Pulse animation ──────────────────────────────────────────────────────
  const startPulse = useCallback(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.15, duration: 600, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      ])
    ).start();
  }, [pulseAnim]);

  const stopPulse = useCallback(() => {
    pulseAnim.stopAnimation();
    pulseAnim.setValue(1);
  }, [pulseAnim]);

  // ─── Server health check ──────────────────────────────────────────────────
  const checkServer = useCallback(async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${SERVER_URL}/health`, { signal: controller.signal });
      clearTimeout(timer);
      setServerOnline(res.ok);
      return res.ok;
    } catch {
      setServerOnline(false);
      return false;
    }
  }, []);

  // ─── App lifecycle ────────────────────────────────────────────────────────
  useEffect(() => {
    checkServer();
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (appStateRef.current.match(/inactive|background/) && next === 'active') {
        checkServer();
      }
      if (next.match(/inactive|background/)) {
        disconnectVoice();
      }
      appStateRef.current = next;
    });
    return () => sub.remove();
  }, []);

  // ─── Scroll to bottom on new messages ────────────────────────────────────
  useEffect(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [messages]);

  // ─── Add message helper ───────────────────────────────────────────────────
  const addMessage = useCallback((role: 'user' | 'assistant', content: string) => {
    setMessages(prev => [
      ...prev,
      { id: Date.now().toString() + Math.random(), role, content, timestamp: new Date() },
    ]);
  }, []);

  // ─── Play audio from base64 ───────────────────────────────────────────────
  const playAudio = useCallback(async (base64Audio: string) => {
    try {
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }
      const uri = `${FileSystem.cacheDirectory}caroline_${Date.now()}.mp3`;
      await FileSystem.writeAsStringAsync(uri, base64Audio, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const { sound } = await Audio.Sound.createAsync({ uri });
      soundRef.current = sound;
      setConnectionState('speaking');
      setStatusText('Caroline is speaking...');
      await sound.playAsync();
      sound.setOnPlaybackStatusUpdate(status => {
        if (status.isLoaded && status.didJustFinish) {
          setConnectionState('connected');
          setStatusText('Listening... speak now');
          startPulse();
        }
      });
    } catch (e) {
      console.error('Audio playback error:', e);
      setConnectionState('connected');
      setStatusText('Listening... speak now');
    }
  }, [startPulse]);

  // ─── Connect to Caroline via xAI Realtime WebSocket ──────────────────────
  const connectVoice = useCallback(async () => {
    if (connectionState !== 'idle' && connectionState !== 'error') return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setConnectionState('connecting');
    setStatusText('Connecting to Caroline...');

    // 1. Get a session token from Railway server
    let token: string;
    let voiceSessionId: string;
    try {
      const res = await fetch(`${SERVER_URL}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'grok-2-audio-latest' }),
        signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 12000); return c.signal; })(),
      });
      if (!res.ok) throw new Error(`Session error: ${res.status}`);
      const data = await res.json();
      token = data.token;
      voiceSessionId = data.session_id;
      setSessionId(voiceSessionId);
    } catch (e: any) {
      setConnectionState('error');
      setStatusText('Could not reach server. Tap to retry.');
      Alert.alert('Connection Error', `Cannot reach Caroline's server.\n\n${e.message}`);
      return;
    }

    // 2. Open xAI Realtime WebSocket
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });

      const ws = new WebSocket(
        `wss://api.x.ai/v1/audio/speech/realtime?session_token=${token}`
      );
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionState('connected');
        setStatusText('Connected — speak now');
        startPulse();
        addMessage('assistant', "Hey! I'm Caroline. What's on your mind?");
      };

      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'transcript' && msg.role === 'user' && msg.text) {
            addMessage('user', msg.text);
          }
          if (msg.type === 'transcript' && msg.role === 'assistant' && msg.text) {
            addMessage('assistant', msg.text);
          }
          if (msg.type === 'audio' && msg.data) {
            stopPulse();
            await playAudio(msg.data);
          }
          if (msg.type === 'error') {
            setStatusText('Error from server. Tap to reconnect.');
            setConnectionState('error');
          }
        } catch (parseErr) {
          console.error('WS parse error:', parseErr);
        }
      };

      ws.onerror = () => {
        setConnectionState('error');
        setStatusText('Connection lost. Tap to reconnect.');
        stopPulse();
      };

      ws.onclose = () => {
        if (connectionState !== 'idle') {
          setConnectionState('idle');
          setStatusText('Tap to talk to Caroline');
          stopPulse();
        }
      };

    } catch (e: any) {
      setConnectionState('error');
      setStatusText('Microphone error. Check permissions.');
      Alert.alert('Microphone Error', e.message);
    }
  }, [connectionState, addMessage, playAudio, startPulse, stopPulse]);

  // ─── Disconnect ───────────────────────────────────────────────────────────
  const disconnectVoice = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (soundRef.current) {
      soundRef.current.unloadAsync();
      soundRef.current = null;
    }
    setConnectionState('idle');
    setStatusText('Tap to talk to Caroline');
    setSessionId(null);
    stopPulse();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [stopPulse]);

  // ─── Main button handler ──────────────────────────────────────────────────
  const handleMainButton = useCallback(() => {
    if (connectionState === 'idle' || connectionState === 'error') {
      connectVoice();
    } else {
      disconnectVoice();
    }
  }, [connectionState, connectVoice, disconnectVoice]);

  // ─── Button appearance ────────────────────────────────────────────────────
  const getButtonColor = () => {
    switch (connectionState) {
      case 'connecting': return '#F59E0B';
      case 'connected': return '#10B981';
      case 'speaking': return '#8B5CF6';
      case 'error': return '#EF4444';
      default: return '#6366F1';
    }
  };

  const getButtonIcon = (): any => {
    switch (connectionState) {
      case 'connecting': return 'hourglass-empty';
      case 'connected': return 'mic';
      case 'speaking': return 'volume-up';
      case 'error': return 'refresh';
      default: return 'mic-none';
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0F0F1A" />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>Caroline</Text>
          <View style={[styles.statusDot, {
            backgroundColor: serverOnline === true ? '#10B981' : serverOnline === false ? '#EF4444' : '#6B7280'
          }]} />
        </View>
        <TouchableOpacity onPress={() => setSettingsVisible(true)} style={styles.settingsBtn}>
          <MaterialIcons name="settings" size={22} color="#9CA3AF" />
        </TouchableOpacity>
      </View>

      {/* Messages */}
      <ScrollView
        ref={scrollRef}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
        showsVerticalScrollIndicator={false}
      >
        {messages.length === 0 && (
          <View style={styles.emptyState}>
            <MaterialIcons name="chat-bubble-outline" size={48} color="#374151" />
            <Text style={styles.emptyText}>Start a conversation with Caroline</Text>
          </View>
        )}
        {messages.map(msg => (
          <View key={msg.id} style={[
            styles.bubble,
            msg.role === 'user' ? styles.userBubble : styles.assistantBubble
          ]}>
            <Text style={[styles.bubbleText, msg.role === 'user' ? styles.userText : styles.assistantText]}>
              {msg.content}
            </Text>
            <Text style={styles.timestamp}>
              {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
        ))}
      </ScrollView>

      {/* Status */}
      <Text style={styles.statusText}>{statusText}</Text>

      {/* Main Voice Button */}
      <View style={styles.buttonContainer}>
        <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
          <TouchableOpacity
            style={[styles.mainButton, { backgroundColor: getButtonColor() }]}
            onPress={handleMainButton}
            activeOpacity={0.8}
          >
            {connectionState === 'connecting' ? (
              <ActivityIndicator size="large" color="#fff" />
            ) : (
              <MaterialIcons name={getButtonIcon()} size={40} color="#fff" />
            )}
          </TouchableOpacity>
        </Animated.View>
      </View>

      {/* Settings Modal */}
      <Modal
        visible={settingsVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setSettingsVisible(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setSettingsVisible(false)}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Caroline Settings</Text>
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>Server</Text>
              <Text style={styles.settingValue} numberOfLines={1}>Railway (always-on)</Text>
            </View>
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>Status</Text>
              <Text style={[styles.settingValue, { color: serverOnline ? '#10B981' : '#EF4444' }]}>
                {serverOnline === null ? 'Checking...' : serverOnline ? 'Online' : 'Offline'}
              </Text>
            </View>
            {sessionId && (
              <View style={styles.settingRow}>
                <Text style={styles.settingLabel}>Session</Text>
                <Text style={styles.settingValue} numberOfLines={1}>{sessionId.slice(0, 20)}...</Text>
              </View>
            )}
            <TouchableOpacity
              style={styles.modalButton}
              onPress={() => { checkServer(); setSettingsVisible(false); }}
            >
              <Text style={styles.modalButtonText}>Refresh Server Status</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modalButton, { backgroundColor: '#374151', marginTop: 4 }]}
              onPress={() => setSettingsVisible(false)}
            >
              <Text style={styles.modalButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F0F1A' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 56, paddingHorizontal: 20, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: '#1F2937',
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: { fontSize: 22, fontWeight: '700', color: '#F9FAFB', letterSpacing: 0.5 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  settingsBtn: { padding: 8 },
  messages: { flex: 1 },
  messagesContent: { padding: 16, gap: 12, paddingBottom: 8 },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 12 },
  emptyText: { color: '#4B5563', fontSize: 15, textAlign: 'center' },
  bubble: { maxWidth: SCREEN_WIDTH * 0.78, borderRadius: 18, padding: 12, paddingHorizontal: 16 },
  userBubble: { alignSelf: 'flex-end', backgroundColor: '#4F46E5' },
  assistantBubble: { alignSelf: 'flex-start', backgroundColor: '#1F2937' },
  bubbleText: { fontSize: 15, lineHeight: 22 },
  userText: { color: '#F9FAFB' },
  assistantText: { color: '#E5E7EB' },
  timestamp: { fontSize: 11, color: '#6B7280', marginTop: 4, textAlign: 'right' },
  statusText: { textAlign: 'center', color: '#9CA3AF', fontSize: 14, paddingVertical: 8, paddingHorizontal: 20 },
  buttonContainer: { alignItems: 'center', paddingBottom: 48, paddingTop: 8 },
  mainButton: {
    width: 88, height: 88, borderRadius: 44,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4, shadowRadius: 8, elevation: 8,
  },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#1F2937', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, gap: 16 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#F9FAFB', marginBottom: 4 },
  settingRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#374151',
  },
  settingLabel: { color: '#9CA3AF', fontSize: 14 },
  settingValue: { color: '#E5E7EB', fontSize: 13, maxWidth: '60%' },
  modalButton: { backgroundColor: '#4F46E5', borderRadius: 12, padding: 14, alignItems: 'center' },
  modalButtonText: { color: '#F9FAFB', fontWeight: '600', fontSize: 15 },
});
