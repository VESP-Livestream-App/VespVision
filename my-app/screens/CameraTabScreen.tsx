import React, { useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { ApiVideoLiveStreamView, type ApiVideoLiveStreamMethods } from '@api.video/react-native-livestream';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

const STREAM_URL = 'rtmp://broadcast.api.video/live';
const STREAM_KEY = 'YOUR_STREAM_KEY';

export default function CameraTabScreen() {
  const streamRef = useRef<ApiVideoLiveStreamMethods | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  const startStreaming = async () => {
    try {
      const started = await streamRef.current?.startStreaming(STREAM_KEY, STREAM_URL);

      if (started) {
        setIsStreaming(true);
      } else {
        Alert.alert('Streaming failed', 'Could not start stream.');
      }
    } catch {
      Alert.alert('Streaming error', 'Unable to start stream.');
    }
  };

  const stopStreaming = () => {
    streamRef.current?.stopStreaming();
    setIsStreaming(false);
  };

  return (
    <ThemedView style={styles.container}>
      <ApiVideoLiveStreamView
        ref={streamRef}
        style={styles.preview}
        camera="back"
        enablePinchedZoom
        video={{ fps: 30, bitrate: 2 * 1024 * 1024, resolution: '720p', gopDuration: 1 }}
        audio={{ bitrate: 128000, sampleRate: 44100, isStereo: true }}
        isMuted={false}
        onConnectionSuccess={() => {
          Alert.alert('Streaming ready', 'Connection established.');
        }}
        onConnectionFailed={(errorCode) => {
          Alert.alert('Connection failed', String(errorCode));
          setIsStreaming(false);
        }}
        onDisconnect={() => {
          setIsStreaming(false);
        }}
        onPermissionsDenied={(permissions) => {
          Alert.alert('Permissions denied', permissions.join(', '));
        }}
      />
      <View style={styles.controls}>
        <ThemedText style={styles.title}>Livestream</ThemedText>
        <ThemedText style={styles.subtitle}>
          URL: {STREAM_URL}
          {'\n'}
          Key: {STREAM_KEY}
        </ThemedText>
        <View style={styles.buttonRow}>
          <Pressable
            onPress={startStreaming}
            disabled={isStreaming}
            style={[styles.button, isStreaming ? styles.buttonDisabled : styles.buttonActive]}
            android_ripple={{ color: 'rgba(255,255,255,0.2)' }}
          >
            <ThemedText style={styles.buttonText}>Start</ThemedText>
          </Pressable>
          <Pressable
            onPress={stopStreaming}
            disabled={!isStreaming}
            style={[styles.button, !isStreaming ? styles.buttonDisabled : styles.buttonStop]}
            android_ripple={{ color: 'rgba(255,255,255,0.2)' }}
          >
            <ThemedText style={styles.buttonText}>Stop</ThemedText>
          </Pressable>
        </View>
        <ThemedText style={styles.statusText}>Status: {isStreaming ? 'Live' : 'Stopped'}</ThemedText>
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'black',
  },
  preview: {
    flex: 1,
  },
  controls: {
    padding: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    gap: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: 'white',
  },
  subtitle: {
    fontSize: 12,
    lineHeight: 18,
    color: '#ddd',
  },
  statusText: {
    fontSize: 12,
    color: '#ddd',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
  },
  button: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 10,
  },
  buttonActive: {
    backgroundColor: '#1f7a1f',
  },
  buttonStop: {
    backgroundColor: '#7a1f1f',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  buttonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
});
