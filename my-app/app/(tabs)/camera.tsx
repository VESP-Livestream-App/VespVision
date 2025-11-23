import React, { useEffect, useState } from 'react';
import { StyleSheet, View, ActivityIndicator, AppState } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
} from 'react-native-vision-camera';
import { useFocusEffect } from '@react-navigation/native';
import { ThemedView } from '@/components/themed-view';
import { ThemedText } from '@/components/themed-text';
import { TestServoPanel } from './testservopanel';
import { BleManager } from 'react-native-ble-plx';

const manager = new BleManager();

export default function CameraScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  const [isActive, setIsActive] = useState(true);

  // BLE state
  const [bleDevice, setBleDevice] = useState<any | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  // Ask for camera permission
  useEffect(() => {
    if (!hasPermission) {
      requestPermission();
    }
  }, [hasPermission, requestPermission]);

  // Pause camera when screen not focused
  useFocusEffect(
    React.useCallback(() => {
      setIsActive(true);
      return () => setIsActive(false);
    }, [])
  );

  // Pause camera when app goes to background
  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextAppState => {
      if (nextAppState === 'active') {
        setIsActive(true);
      } else {
        setIsActive(false);
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);

  // BLE: scan & connect to "bballtripod"
  useEffect(() => {
    const connectToTripod = async () => {
      if (bleDevice) return; // already connected

      setIsConnecting(true);

      manager.startDeviceScan(null, null, async (error, dev) => {
        if (error) {
          console.log('Scan error:', error);
          setIsConnecting(false);
          return;
        }

        if (dev?.name === 'bballtripod') {
          console.log('Found tripod:', dev.name);
          manager.stopDeviceScan();

          try {
            const d = await dev.connect();
            await d.discoverAllServicesAndCharacteristics();
            console.log('Connected to tripod!');
            setBleDevice(d);
          } catch (e) {
            console.log('Connection failed:', e);
          } finally {
            setIsConnecting(false);
          }
        }
      });

      // Stop scanning after 10s if nothing found
      setTimeout(() => {
        manager.stopDeviceScan();
        setIsConnecting(false);
      }, 10000);
    };

    connectToTripod();
  }, [bleDevice]);

  // Permission / device checks
  if (!hasPermission) {
    return (
      <ThemedView style={styles.container}>
        <ThemedText style={styles.message}>
          Camera permission is required
        </ThemedText>
        <ActivityIndicator size="large" style={styles.loader} />
      </ThemedView>
    );
  }

  if (!device) {
    return (
      <ThemedView style={styles.container}>
        <ThemedText style={styles.message}>No camera device found</ThemedText>
        <ActivityIndicator size="large" style={styles.loader} />
      </ThemedView>
    );
  }

  // Main render
  return (
    <View style={styles.container}>
      <Camera style={styles.camera} device={device} isActive={isActive} />

      {/* Top overlay title */}
      <View style={styles.overlay}>
        <ThemedText style={styles.title}>Camera View</ThemedText>
      </View>

      {/* Bottom overlay: either status text or the slider panel */}
      {bleDevice ? (
        <TestServoPanel
          device={bleDevice}
          SERVICE_UUID="499d163b-be72-4691-a8af-61657909ac11"
          CHAR_UUID="b793f920-016e-49ea-a4fd-15fe1d21a1a5"
        />
      ) : (
        <View style={styles.statusOverlay}>
          <ThemedText style={styles.statusText}>
            {isConnecting
              ? 'Connecting to bballtripod...'
              : 'Searching for bballtripod...'}
          </ThemedText>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  camera: {
    flex: 1,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    padding: 20,
    paddingTop: 60,
    alignItems: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: 'white',
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: -1, height: 1 },
    textShadowRadius: 10,
  },
  statusOverlay: {
    position: 'absolute',
    bottom: 40,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  statusText: {
    fontSize: 16,
    color: 'white',
  },
  message: {
    fontSize: 18,
    textAlign: 'center',
    marginBottom: 20,
  },
  loader: {
    marginTop: 20,
  },
});
