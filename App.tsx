import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Alert,
  Animated,
  Platform,
  Dimensions,
  StatusBar,
  Modal,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import { MaterialIcons } from '@expo/vector-icons';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// ─── Types ───────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: Date;
}

type AppState = 'idle' | 'recording' | 'sending' | 'playing';

// ─── Main App ────────────────────────────────────────────────────────────────

export default function App() {
  useKeepAwake();

  // State
  const [serverUrl, setServerUrl] = useState<string>('http://YOUR_SERVER_IP:8000');
  const [appState, setAppState] = useState<AppState>('idle');
  const [messages, setMessages] = useState<Message[]>([]);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [serverStatus, setServerStatus] = useState<'unknown' | 'connected' | 'error'>('unknown');
  const [tempUrl, setTempUrl] = useState<string>('');
  const [statusText, setStatusText] = useState<string>('Tap & hold to talk');
  const [recordingDuration, setRecordingDuration] = useState<number>(0);

  // Refs
  const recording = useRef<Audio.Recording | null>(null);
  const sound = useRef<Audio.Sound | null>(null);
  const scrollViewRef = useRef<ScrollView>(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;
  const durationTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Audio Setup ─────────────────────────────────────────────────────────

  useEffect(() => {
    setupAudio();
    return () => {
      cleanupAudio();
    };
  }, []);

  const setupAudio = async () => {
    try {
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Microphone permission is needed for voice conversations.');
        return;
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
    } catch (error) {
      console.error('Audio setup error:', error);
    }
  };

  const cleanupAudio = async () => {
    if (recording.current) {
      try { await recording.current.stopAndUnloadAsync(); } catch {}
    }
    if (sound.current) {
      try { await sound.current.unloadAsync(); } catch {}
    }
    if (durationTimer.current) {
      clearInterval(durationTimer.current);
    }
  };

  // ─── Animations ──────────────────────────────────────────────────────────

  const startPulseAnimation = () => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.15,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true,
        }),
      ])
    ).start();

    Animated.timing(glowAnim, {
      toValue: 1,
      duration: 300,
      useNativeDriver: false,
    }).start();
  };

  const stopPulseAnimation = () => {
    pulseAnim.stopAnimation();
    pulseAnim.setValue(1);
    Animated.timing(glowAnim, {
      toValue: 0,
      duration: 200,
      useNativeDriver: false,
    }).start();
  };

  // ─── Recording ───────────────────────────────────────────────────────────

  const startRecording = async () => {
    try {
      // Cleanup any previous sound
      if (sound.current) {
        await sound.current.unloadAsync();
        sound.current = null;
      }

      // Ensure audio mode is set for recording
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });

      const { recording: newRecording } = await Audio.Recording.createAsync(
        {
          isMeteringEnabled: true,
          android: {
            extension: '.wav',
            outputFormat: Audio.AndroidOutputFormat.DEFAULT,
            audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
            sampleRate: 16000,
            numberOfChannels: 1,
            bitRate: 256000,
          },
          ios: {
            extension: '.wav',
            outputFormat: Audio.IOSOutputFormat.LINEARPCM,
            audioQuality: Audio.IOSAudioQuality.HIGH,
            sampleRate: 16000,
            numberOfChannels: 1,
            bitRate: 256000,
            linearPCMBitDepth: 16,
            linearPCMIsBigEndian: false,
            linearPCMIsFloat: false,
          },
          web: {
            mimeType: 'audio/wav',
            bitsPerSecond: 256000,
          },
        }
      );

      recording.current = newRecording;
      setAppState('recording');
      setStatusText('Recording... Release to send');
      setRecordingDuration(0);

      // Start duration timer
      durationTimer.current = setInterval(() => {
        setRecordingDuration(prev => prev + 1);
      }, 1000);

      startPulseAnimation();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch (error) {
      console.error('Failed to start recording:', error);
      setStatusText('Recording failed. Try again.');
      setAppState('idle');
    }
  };

  const stopRecording = async () => {
    stopPulseAnimation();

    if (durationTimer.current) {
      clearInterval(durationTimer.current);
      durationTimer.current = null;
    }

    if (!recording.current) {
      setAppState('idle');
      setStatusText('Tap & hold to talk');
      return;
    }

    try {
      setAppState('sending');
      setStatusText('Processing...');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      await recording.current.stopAndUnloadAsync();
      const uri = recording.current.getURI();
      recording.current = null;

      if (!uri) {
        throw new Error('No recording URI');
      }

      // Check if recording is too short (less than 0.5s)
      if (recordingDuration < 1) {
        // Still send it, the server can handle short audio
      }

      await sendAudioToServer(uri);
    } catch (error) {
      console.error('Failed to stop recording:', error);
      setStatusText('Error. Tap & hold to talk');
      setAppState('idle');
      addMessage('system', 'Error processing recording. Please try again.');
    }
  };

  // ─── Server Communication ────────────────────────────────────────────────

  const sendAudioToServer = async (audioUri: string) => {
    try {
      setStatusText('Sending to AI...');

      // Add user message placeholder
      addMessage('user', '🎤 [Voice message sent]');

      const formData = new FormData();
      formData.append('audio', {
        uri: audioUri,
        type: 'audio/wav',
        name: 'recording.wav',
      } as any);

      const response = await fetch(`${serverUrl}/api/voice`, {
        method: 'POST',
        body: formData,
        headers: {
          'Accept': 'application/octet-stream',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Server error ${response.status}: ${errorText}`);
      }

      // Check content type to determine response format
      const contentType = response.headers.get('content-type') || '';
      
      if (contentType.includes('application/json')) {
        // Server returned JSON (might include text + audio URL or base64)
        const jsonData = await response.json();
        
        if (jsonData.text) {
          addMessage('assistant', jsonData.text);
        }
        
        if (jsonData.audio_url) {
          // Download and play audio from URL
          setStatusText('Playing response...');
          setAppState('playing');
          await playAudioFromUrl(`${serverUrl}${jsonData.audio_url}`);
        } else if (jsonData.audio_base64) {
          // Decode base64 audio and play
          setStatusText('Playing response...');
          setAppState('playing');
          const audioPath = `${FileSystem.cacheDirectory}response_${Date.now()}.mp3`;
          await FileSystem.writeAsStringAsync(audioPath, jsonData.audio_base64, {
            encoding: FileSystem.EncodingType.Base64,
          });
          await playAudioFromUrl(audioPath);
        } else {
          setAppState('idle');
          setStatusText('Tap & hold to talk');
        }
      } else {
        // Server returned raw audio bytes
        setStatusText('Playing response...');
        setAppState('playing');

        // Read response as blob/arraybuffer and save to file
        const audioBlob = await response.blob();
        const reader = new FileReader();
        
        const base64Data = await new Promise<string>((resolve, reject) => {
          reader.onloadend = () => {
            const base64 = (reader.result as string).split(',')[1];
            resolve(base64);
          };
          reader.onerror = reject;
          reader.readAsDataURL(audioBlob);
        });

        const audioPath = `${FileSystem.cacheDirectory}response_${Date.now()}.mp3`;
        await FileSystem.writeAsStringAsync(audioPath, base64Data, {
          encoding: FileSystem.EncodingType.Base64,
        });

        // Try to extract text from response headers
        const transcriptHeader = response.headers.get('x-transcript');
        const responseTextHeader = response.headers.get('x-response-text');
        if (responseTextHeader) {
          addMessage('assistant', decodeURIComponent(responseTextHeader));
        } else if (transcriptHeader) {
          addMessage('assistant', `You said: "${decodeURIComponent(transcriptHeader)}"`);
        } else {
          addMessage('assistant', '🔊 [Voice response]');
        }

        await playAudioFromUrl(audioPath);
      }
    } catch (error: any) {
      console.error('Server communication error:', error);
      setAppState('idle');
      setStatusText('Connection error. Tap & hold to talk');
      addMessage('system', `Error: ${error.message || 'Could not reach server'}`);
    }
  };

  const playAudioFromUrl = async (uri: string) => {
    try {
      // Switch audio mode for playback
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: false,
      });

      if (sound.current) {
        await sound.current.unloadAsync();
      }

      const { sound: newSound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true, volume: 1.0 },
        (status) => {
          if (status.isLoaded && status.didJustFinish) {
            setAppState('idle');
            setStatusText('Tap & hold to talk');
          }
        }
      );

      sound.current = newSound;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      console.error('Playback error:', error);
      setAppState('idle');
      setStatusText('Playback failed. Tap & hold to talk');
    }
  };

  // ─── Health Check ────────────────────────────────────────────────────────

  const checkServerHealth = async (url?: string) => {
    const checkUrl = url || serverUrl;
    try {
      setServerStatus('unknown');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`${checkUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      
      if (response.ok) {
        setServerStatus('connected');
        return true;
      } else {
        setServerStatus('error');
        return false;
      }
    } catch {
      setServerStatus('error');
      return false;
    }
  };

  // ─── Helpers ─────────────────────────────────────────────────────────────

  const addMessage = (role: Message['role'], text: string) => {
    const msg: Message = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      role,
      text,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, msg]);
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 100);
  };

  const clearConversation = () => {
    setMessages([]);
  };

  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // ─── Button Colors ──────────────────────────────────────────────────────

  const getButtonColor = (): string => {
    switch (appState) {
      case 'recording': return '#ff4444';
      case 'sending': return '#ffaa00';
      case 'playing': return '#44bb44';
      default: return '#4a90d9';
    }
  };

  const getButtonIcon = (): keyof typeof MaterialIcons.glyphMap => {
    switch (appState) {
      case 'recording': return 'mic';
      case 'sending': return 'hourglass-top';
      case 'playing': return 'volume-up';
      default: return 'mic-none';
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Voice AI</Text>
        <View style={styles.headerRight}>
          <View style={[
            styles.statusDot,
            { backgroundColor: serverStatus === 'connected' ? '#44bb44' : serverStatus === 'error' ? '#ff4444' : '#888' }
          ]} />
          <TouchableOpacity onPress={() => { setTempUrl(serverUrl); setShowSettings(true); }} style={styles.settingsBtn}>
            <MaterialIcons name="settings" size={24} color="#aaa" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Messages */}
      <ScrollView
        ref={scrollViewRef}
        style={styles.messagesContainer}
        contentContainerStyle={styles.messagesContent}
        onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
      >
        {messages.length === 0 && (
          <View style={styles.emptyState}>
            <MaterialIcons name="record-voice-over" size={64} color="#333" />
            <Text style={styles.emptyText}>Hold the button and speak</Text>
            <Text style={styles.emptySubtext}>Your AI assistant is ready</Text>
            {serverStatus !== 'connected' && (
              <TouchableOpacity 
                style={styles.connectBtn}
                onPress={() => { setTempUrl(serverUrl); setShowSettings(true); }}
              >
                <Text style={styles.connectBtnText}>Configure Server</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
        {messages.map((msg) => (
          <View
            key={msg.id}
            style={[
              styles.messageBubble,
              msg.role === 'user' ? styles.userBubble :
              msg.role === 'assistant' ? styles.assistantBubble :
              styles.systemBubble,
            ]}
          >
            <Text style={[
              styles.messageText,
              msg.role === 'system' && styles.systemText,
            ]}>
              {msg.text}
            </Text>
            <Text style={styles.messageTime}>
              {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
        ))}
      </ScrollView>

      {/* Bottom Controls */}
      <View style={styles.bottomArea}>
        {/* Status Text */}
        <Text style={styles.statusText}>
          {appState === 'recording' ? `${statusText}  ${formatDuration(recordingDuration)}` : statusText}
        </Text>

        {/* Push-to-Talk Button */}
        <View style={styles.buttonContainer}>
          {appState === 'sending' ? (
            <View style={[styles.talkButton, { backgroundColor: getButtonColor() }]}>
              <ActivityIndicator size="large" color="#fff" />
            </View>
          ) : (
            <Pressable
              onPressIn={() => {
                if (appState === 'idle') {
                  startRecording();
                }
              }}
              onPressOut={() => {
                if (appState === 'recording') {
                  stopRecording();
                }
              }}
              disabled={appState === 'sending'}
              style={({ pressed }) => [
                styles.talkButtonPressable,
              ]}
            >
              <Animated.View
                style={[
                  styles.talkButton,
                  {
                    backgroundColor: getButtonColor(),
                    transform: [{ scale: appState === 'recording' ? pulseAnim : 1 }],
                    shadowColor: getButtonColor(),
                    shadowOpacity: appState === 'recording' ? 0.8 : 0.3,
                    shadowRadius: appState === 'recording' ? 20 : 10,
                    elevation: appState === 'recording' ? 20 : 8,
                  },
                ]}
              >
                <MaterialIcons name={getButtonIcon()} size={48} color="#fff" />
              </Animated.View>
            </Pressable>
          )}
        </View>

        {/* Clear button */}
        {messages.length > 0 && appState === 'idle' && (
          <TouchableOpacity style={styles.clearBtn} onPress={clearConversation}>
            <MaterialIcons name="delete-outline" size={20} color="#666" />
            <Text style={styles.clearBtnText}>Clear</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Settings Modal */}
      <Modal
        visible={showSettings}
        transparent
        animationType="slide"
        onRequestClose={() => setShowSettings(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Server Settings</Text>
            
            <Text style={styles.inputLabel}>Server URL</Text>
            <TextInput
              style={styles.urlInput}
              value={tempUrl}
              onChangeText={setTempUrl}
              placeholder="http://your-server-ip:8000"
              placeholderTextColor="#666"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <Text style={styles.inputHint}>
              Enter the full URL of your RunPod server's API endpoint (e.g., https://xyz-8000.proxy.runpod.net)
            </Text>

            <View style={styles.statusRow}>
              <Text style={styles.statusLabel}>Status:</Text>
              <View style={[
                styles.statusBadge,
                { backgroundColor: serverStatus === 'connected' ? '#1a3d1a' : serverStatus === 'error' ? '#3d1a1a' : '#2a2a2a' }
              ]}>
                <View style={[
                  styles.statusDotSmall,
                  { backgroundColor: serverStatus === 'connected' ? '#44bb44' : serverStatus === 'error' ? '#ff4444' : '#888' }
                ]} />
                <Text style={[
                  styles.statusBadgeText,
                  { color: serverStatus === 'connected' ? '#44bb44' : serverStatus === 'error' ? '#ff4444' : '#888' }
                ]}>
                  {serverStatus === 'connected' ? 'Connected' : serverStatus === 'error' ? 'Not Reachable' : 'Unknown'}
                </Text>
              </View>
            </View>

            <TouchableOpacity
              style={styles.testBtn}
              onPress={() => checkServerHealth(tempUrl)}
            >
              <MaterialIcons name="wifi-tethering" size={20} color="#4a90d9" />
              <Text style={styles.testBtnText}>Test Connection</Text>
            </TouchableOpacity>

            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setShowSettings(false)}
              >
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.saveBtn}
                onPress={() => {
                  setServerUrl(tempUrl);
                  setShowSettings(false);
                  checkServerHealth(tempUrl);
                }}
              >
                <Text style={styles.saveBtnText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: Platform.OS === 'android' ? 40 : 50,
    paddingHorizontal: 20,
    paddingBottom: 12,
    backgroundColor: '#16213e',
    borderBottomWidth: 1,
    borderBottomColor: '#0f3460',
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#e0e0e0',
    letterSpacing: 1,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  settingsBtn: {
    padding: 4,
  },
  messagesContainer: {
    flex: 1,
    paddingHorizontal: 16,
  },
  messagesContent: {
    paddingVertical: 16,
    flexGrow: 1,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 80,
  },
  emptyText: {
    fontSize: 18,
    color: '#555',
    marginTop: 16,
    fontWeight: '600',
  },
  emptySubtext: {
    fontSize: 14,
    color: '#444',
    marginTop: 8,
  },
  connectBtn: {
    marginTop: 24,
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: '#0f3460',
    borderRadius: 20,
  },
  connectBtnText: {
    color: '#4a90d9',
    fontSize: 14,
    fontWeight: '600',
  },
  messageBubble: {
    maxWidth: '85%',
    padding: 14,
    borderRadius: 16,
    marginBottom: 10,
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#0f3460',
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#2a2a4a',
    borderBottomLeftRadius: 4,
  },
  systemBubble: {
    alignSelf: 'center',
    backgroundColor: '#2a1a1a',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  messageText: {
    color: '#e0e0e0',
    fontSize: 15,
    lineHeight: 22,
  },
  systemText: {
    color: '#ff8888',
    fontSize: 13,
    textAlign: 'center',
  },
  messageTime: {
    color: '#666',
    fontSize: 11,
    marginTop: 6,
    textAlign: 'right',
  },
  bottomArea: {
    paddingBottom: Platform.OS === 'android' ? 24 : 34,
    paddingTop: 12,
    backgroundColor: '#16213e',
    borderTopWidth: 1,
    borderTopColor: '#0f3460',
    alignItems: 'center',
  },
  statusText: {
    color: '#888',
    fontSize: 14,
    marginBottom: 16,
    fontWeight: '500',
  },
  buttonContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  talkButtonPressable: {
    borderRadius: 60,
  },
  talkButton: {
    width: 100,
    height: 100,
    borderRadius: 50,
    justifyContent: 'center',
    alignItems: 'center',
    shadowOffset: { width: 0, height: 4 },
  },
  clearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 6,
  },
  clearBtnText: {
    color: '#666',
    fontSize: 13,
  },
  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modalContent: {
    backgroundColor: '#1e1e3a',
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: '#0f3460',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#e0e0e0',
    marginBottom: 20,
    textAlign: 'center',
  },
  inputLabel: {
    color: '#aaa',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  urlInput: {
    backgroundColor: '#2a2a4a',
    borderRadius: 12,
    padding: 14,
    color: '#e0e0e0',
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#0f3460',
  },
  inputHint: {
    color: '#666',
    fontSize: 12,
    marginTop: 8,
    lineHeight: 18,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 20,
    gap: 12,
  },
  statusLabel: {
    color: '#aaa',
    fontSize: 14,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    gap: 6,
  },
  statusDotSmall: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusBadgeText: {
    fontSize: 13,
    fontWeight: '600',
  },
  testBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#0f3460',
    gap: 8,
  },
  testBtnText: {
    color: '#4a90d9',
    fontSize: 14,
    fontWeight: '600',
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 24,
    gap: 12,
  },
  cancelBtn: {
    flex: 1,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#2a2a4a',
    alignItems: 'center',
  },
  cancelBtnText: {
    color: '#aaa',
    fontSize: 15,
    fontWeight: '600',
  },
  saveBtn: {
    flex: 1,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#4a90d9',
    alignItems: 'center',
  },
  saveBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
});
