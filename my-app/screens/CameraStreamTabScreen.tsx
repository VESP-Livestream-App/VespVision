import useBle from '@/app/hooks/use-ble';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission } from 'react-native-vision-camera';

const NUDGE_STEP_DEG = 3;
const NUDGE_SPEED_DEG_PER_SEC = 28;
const LONG_PRESS_DELAY_MS = 240;
const LONG_PRESS_REPEAT_MS = 160;

export default function CameraStreamTabScreen() {
  const router = useRouter();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();
  const {
    devices,
    scanning,
    startScan,
    stopScan,
    connectToDevice,
    disconnectDevice,
    connectingId,
    connectedId,
    currentPos,
    sendDeltaAngleTime,
  } = useBle();

  const [leftBound, setLeftBound] = useState<number | null>(null);
  const [rightBound, setRightBound] = useState<number | null>(null);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [simulatedPos, setSimulatedPos] = useState(90);
  const nudgeInFlightRef = useRef(false);
  const holdStartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdDirectionRef = useRef<(-1 | 1)>(1);
  const holdPressStartedAtRef = useRef(0);

  const connected = Boolean(connectedId);
  const hasBounds = leftBound !== null && rightBound !== null;
  const effectivePos = connected && currentPos !== null ? currentPos : simulatedPos;
  const isLandscape = screenWidth > screenHeight;
  const cardWidth = useMemo(() => {
    if (isLandscape) {
      return Math.min(screenWidth * 0.58, 680);
    }
    return Math.min(screenWidth * 0.95, 700);
  }, [isLandscape, screenWidth]);

  const hintText = useMemo(() => {
    if (!connected) return 'BLE not connected. You can still calibrate and test UI with simulated angle.';
    if (leftBound === null) return 'Use arrows to align left rim, then set left bound.';
    if (rightBound === null) return 'Align right rim, then set right bound.';
    return 'Bounds locked. Ready to start tracking stream.';
  }, [connected, leftBound, rightBound]);

  const nudge = async (direction: -1 | 1) => {
    if (nudgeInFlightRef.current) {
      return;
    }
    const delta = direction * NUDGE_STEP_DEG;
    const timeMs = Math.max(80, Math.round((Math.abs(delta) / NUDGE_SPEED_DEG_PER_SEC) * 1000));
    if (!connectedId) {
      setSimulatedPos((prev) => Math.max(0, Math.min(180, prev + delta)));
      return;
    }
    nudgeInFlightRef.current = true;
    try {
      console.log(
        `🎛️ [Calib] delta=${delta.toFixed(1)}° time=${timeMs}ms current=${currentPos === null ? '--' : `${currentPos.toFixed(1)}°`}`
      );
      await sendDeltaAngleTime(connectedId, delta, timeMs);
    } finally {
      nudgeInFlightRef.current = false;
    }
  };

  const clearHoldTimers = () => {
    if (holdStartTimeoutRef.current) {
      clearTimeout(holdStartTimeoutRef.current);
      holdStartTimeoutRef.current = null;
    }
    if (holdTimerRef.current) {
      clearInterval(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const startHoldNudge = (direction: -1 | 1) => {
    clearHoldTimers();
    holdDirectionRef.current = direction;
    holdPressStartedAtRef.current = Date.now();
    holdStartTimeoutRef.current = setTimeout(() => {
      void nudge(holdDirectionRef.current);
      holdTimerRef.current = setInterval(() => {
        void nudge(holdDirectionRef.current);
      }, LONG_PRESS_REPEAT_MS);
    }, LONG_PRESS_DELAY_MS);
  };

  const handlePressOut = (direction: -1 | 1) => {
    const pressDuration = Date.now() - holdPressStartedAtRef.current;
    const wasLongPress = holdTimerRef.current !== null || pressDuration >= LONG_PRESS_DELAY_MS;
    clearHoldTimers();
    if (!wasLongPress) {
      void nudge(direction);
    }
  };

  useEffect(() => () => clearHoldTimers(), []);

  const setLeft = () => {
    setLeftBound(effectivePos);
  };

  const setRight = () => {
    setRightBound(effectivePos);
  };

  const resetBounds = () => {
    setLeftBound(null);
    setRightBound(null);
  };

  const startTracking = () => {
    if (!hasBounds) {
      Alert.alert('Bounds required', 'Set left and right bounds before starting.');
      return;
    }
    const minBound = Math.min(leftBound!, rightBound!);
    const maxBound = Math.max(leftBound!, rightBound!);
    router.push({
      pathname: '/camera-stream-full',
      params: {
        minBound: String(minBound),
        maxBound: String(maxBound),
      },
    });
  };

  const openCalibration = async () => {
    if (!hasPermission) {
      const granted = await requestPermission();
      if (!granted) {
        Alert.alert('Camera permission needed', 'Grant camera permission to use full-screen calibration.');
        return;
      }
    }
    setIsCalibrating(true);
  };

  return (
    <ThemedView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable style={styles.setupBackButton} onPress={() => router.back()}>
          <ThemedText style={styles.setupBackButtonText}>← Back</ThemedText>
        </Pressable>
        <ThemedText style={styles.title}>Camera Stream</ThemedText>
        <ThemedText style={styles.subtitle}>Simple setup before live tracking starts.</ThemedText>

        <View style={[styles.card, { width: cardWidth }]}>
          <ThemedText style={styles.cardTitle}>1) BLE Connection</ThemedText>
          <ThemedText style={styles.status}>
            {connectedId ? `Connected: ${connectedId}` : 'Not connected'}
          </ThemedText>
          <View style={styles.row}>
            <Pressable style={[styles.button, styles.secondary]} onPress={scanning ? stopScan : startScan}>
              <ThemedText style={styles.buttonText}>{scanning ? 'Stop Scan' : 'Scan Devices'}</ThemedText>
            </Pressable>
            {connectedId ? (
              <Pressable style={[styles.button, styles.ghost]} onPress={() => disconnectDevice(connectedId)}>
                <ThemedText style={styles.buttonText}>Disconnect</ThemedText>
              </Pressable>
            ) : null}
          </View>
          {devices.slice(0, 6).map((device) => (
            <View key={device.id} style={styles.deviceRow}>
              <ThemedText style={styles.deviceText}>{device.name ?? 'Unnamed Device'}</ThemedText>
              <Pressable
                style={[styles.smallButton, connectedId === device.id && styles.smallActive]}
                onPress={() => connectToDevice(device)}
                disabled={Boolean(connectingId)}
              >
                <ThemedText style={styles.smallButtonText}>
                  {connectedId === device.id ? 'Connected' : connectingId === device.id ? 'Connecting...' : 'Connect'}
                </ThemedText>
              </Pressable>
            </View>
          ))}
        </View>

        <View style={[styles.card, { width: cardWidth }]}>
          <ThemedText style={styles.cardTitle}>2) Set Rim Bounds</ThemedText>
          <ThemedText style={styles.status}>{hintText}</ThemedText>
          <ThemedText style={styles.status}>
            Servo position: {`${effectivePos.toFixed(1)} deg`}{connected ? '' : ' (sim)'}
          </ThemedText>
          <Pressable
            style={[styles.button, styles.secondary]}
            onPress={openCalibration}
          >
            <ThemedText style={styles.buttonText}>Open Full-Screen Calibration</ThemedText>
          </Pressable>
          <ThemedText style={styles.status}>
            Left: {leftBound === null ? '--' : `${leftBound.toFixed(1)} deg`} | Right: {rightBound === null ? '--' : `${rightBound.toFixed(1)} deg`}
          </ThemedText>
          <Pressable style={[styles.button, styles.ghost]} onPress={resetBounds}>
            <ThemedText style={styles.buttonText}>Reset Bounds</ThemedText>
          </Pressable>
        </View>

        <View style={[styles.card, { width: cardWidth }]}>
          <ThemedText style={styles.cardTitle}>3) Start Tracking</ThemedText>
          <Pressable
            style={[styles.button, styles.primary, !hasBounds && styles.disabled]}
            onPress={startTracking}
            disabled={!hasBounds}
          >
            <ThemedText style={styles.buttonText}>Start Track / Stream</ThemedText>
          </Pressable>
        </View>
      </ScrollView>

      {isCalibrating && (
        <View style={styles.calibrationOverlay}>
          {device && hasPermission ? (
            <Camera style={StyleSheet.absoluteFill} device={device} isActive={true} />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.calibrationFallback]} />
          )}

          <View style={styles.calibrationTopBar}>
            <Pressable style={styles.topBarButton} onPress={() => { setIsCalibrating(false); }}>
              <ThemedText style={styles.topBarButtonText}>Done</ThemedText>
            </Pressable>
            <ThemedText style={styles.topBarText}>
              Servo: {`${effectivePos.toFixed(1)} deg`}{connected ? '' : ' (sim)'}
            </ThemedText>
          </View>

          <View style={styles.calibrationBottomPanel}>
            <ThemedText style={styles.calibrationHint}>Center each rim and save left/right bounds.</ThemedText>
            <View style={styles.row}>
              <Pressable
                style={[styles.button, styles.secondary]}
                onPressIn={() => startHoldNudge(-1)}
                onPressOut={() => handlePressOut(-1)}
              >
                <ThemedText style={styles.buttonText}>Nudge Left</ThemedText>
              </Pressable>
              <Pressable
                style={[styles.button, styles.secondary]}
                onPressIn={() => startHoldNudge(1)}
                onPressOut={() => handlePressOut(1)}
              >
                <ThemedText style={styles.buttonText}>Nudge Right</ThemedText>
              </Pressable>
            </View>
            <View style={styles.row}>
              <Pressable style={[styles.button, styles.secondary]} onPress={setLeft}>
                <ThemedText style={styles.buttonText}>
                  Set Left ({leftBound === null ? '--' : leftBound.toFixed(1)})
                </ThemedText>
              </Pressable>
              <Pressable style={[styles.button, styles.secondary]} onPress={setRight}>
                <ThemedText style={styles.buttonText}>
                  Set Right ({rightBound === null ? '--' : rightBound.toFixed(1)})
                </ThemedText>
              </Pressable>
            </View>
          </View>
        </View>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 20,
    paddingTop: 56,
    gap: 14,
  },
  setupBackButton: {
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  setupBackButtonText: {
    fontSize: 13,
    opacity: 0.78,
  },
  title: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700',
    textAlign: 'center',
    alignSelf: 'center',
  },
  subtitle: {
    fontSize: 14,
    opacity: 0.8,
    textAlign: 'center',
    alignSelf: 'center',
  },
  card: {
    alignSelf: 'center',
    borderRadius: 14,
    padding: 14,
    gap: 10,
    backgroundColor: 'rgba(0,0,0,0.06)',
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  status: {
    fontSize: 13,
    opacity: 0.8,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  button: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: {
    backgroundColor: '#1f6feb',
  },
  secondary: {
    backgroundColor: 'rgba(0,0,0,0.7)',
  },
  ghost: {
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  disabled: {
    opacity: 0.45,
  },
  buttonText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '600',
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  deviceText: {
    flex: 1,
    marginRight: 10,
    fontSize: 13,
  },
  smallButton: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  smallActive: {
    backgroundColor: '#1f6feb',
  },
  smallButtonText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
  calibrationOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'black',
  },
  calibrationFallback: {
    backgroundColor: 'black',
  },
  calibrationTopBar: {
    position: 'absolute',
    top: 50,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  topBarButton: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  topBarButtonText: {
    color: 'white',
    fontWeight: '700',
  },
  topBarText: {
    color: 'white',
    fontWeight: '600',
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  calibrationBottomPanel: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 20,
    borderRadius: 12,
    padding: 12,
    gap: 10,
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  calibrationHint: {
    color: 'white',
    fontSize: 12,
    opacity: 0.9,
  },
});
