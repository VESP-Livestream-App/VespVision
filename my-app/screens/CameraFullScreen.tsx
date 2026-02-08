import React, { useEffect, useState, useRef, useMemo } from 'react';
import { StyleSheet, View, ActivityIndicator, AppState, Pressable, Switch } from 'react-native';
import { 
  Camera, 
  useCameraDevice, 
  useCameraPermission,
  useFrameProcessor,
  Frame,
} from 'react-native-vision-camera';
import { createResizePlugin } from 'vision-camera-resize-plugin';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as ImageManipulator from 'expo-image-manipulator';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { ThemedView } from '@/components/themed-view';
import { ThemedText } from '@/components/themed-text';
import { loadYoloModel, closeYoloModel } from '@/modules/yoloModel';
import { runYoloInference } from '@/modules/yoloInference';
import type { Detection } from '@/modules/yoloUtils';
import { useRunOnJS, useSharedValue } from 'react-native-worklets-core';
import { addSnapshot } from '@/modules/snapshotStore';
import { getBallSide, getBallSideFromCenterX, type BallSide } from '@/modules/ballDirection';
import { getTurnSignalForBLE } from '@/modules/bleTurnSignal';
import { sendTurnSignal } from '@/modules/bleClient';
import { ByteTrackLite, type Det, type Track } from '@/src/tracking/byteTrackLite';

const base64ToUint8Array = (base64: string): Uint8Array => {
  const binaryString = global.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

const decodeJpegToRgb = (base64Jpeg: string): Uint8Array => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const jpeg = require('jpeg-js');
  const jpgData = base64ToUint8Array(base64Jpeg);
  const decoded = jpeg.decode(jpgData, { useTArray: true });
  const { data, width, height } = decoded;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4) {
    rgb[j++] = data[i];     // R
    rgb[j++] = data[i + 1]; // G
    rgb[j++] = data[i + 2]; // B
  }
  return rgb;
};

const nowMs = (): number => (
  typeof global !== 'undefined' && (global as { performance?: { now?: () => number } }).performance?.now
    ? (global as { performance: { now: () => number } }).performance.now()
    : Date.now()
);

const INPUT_SIZE = 640;
const LIVE_INFERENCE_FPS = 10;
const ENABLE_LIVE_LOGS = false;
const ENABLE_TIMING_LOGS = true;
const LIVE_LOG_EVERY = 30;
const BASKETBALL_LABEL = 'basketball';

const detectionToDet = (det: Detection): Det => ({
  x1: det.x,
  y1: det.y,
  x2: det.x + det.width,
  y2: det.y + det.height,
  score: det.confidence,
});

const trackToDetection = (track: Track): Detection => ({
  x: track.x1,
  y: track.y1,
  width: Math.max(1, track.x2 - track.x1),
  height: Math.max(1, track.y2 - track.y1),
  confidence: track.score,
  class: 0,
  className: BASKETBALL_LABEL,
});

const getBestTrack = (tracks: Track[]): Track | null => {
  if (tracks.length === 0) {
    return null;
  }
  let best: Track | null = null;
  for (let i = 0; i < tracks.length; i += 1) {
    const t = tracks[i];
    if (t.lost !== 0) {
      continue;
    }
    if (!best || t.score > best.score) {
      best = t;
    }
  }
  return best ?? tracks[0];
};

export default function CameraFullScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const router = useRouter();
  const cameraRef = useRef<Camera>(null);
  const device = useCameraDevice('back');
  const [isActive, setIsActive] = useState(true);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [isModelLoaded, setIsModelLoaded] = useState(false);
  const [isInferencing, setIsInferencing] = useState(false);
  const [isSnapshotting, setIsSnapshotting] = useState(false);
  const [lastInferenceAt, setLastInferenceAt] = useState<number | null>(null);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
  const [lastFrameSize, setLastFrameSize] = useState({ width: 0, height: 0 });
  const [ballSide, setBallSide] = useState<BallSide>(null);
  const [fps, setFps] = useState(0);
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('landscape');
  const [isLiveInference, setIsLiveInference] = useState(false);
  const singleShotRequestId = useSharedValue(0);
  const lastProcessedRequestId = useSharedValue(0);
  const fpsFrameCount = useSharedValue(0);
  const fpsLastTimestamp = useSharedValue(0);
  const isModelLoadedShared = useSharedValue(false);
  const isLiveInferenceShared = useSharedValue(false);
  const lastLiveInferenceTime = useSharedValue(0);
  const isInferencingShared = useSharedValue(false);
  const lastLiveDetectionAtRef = useRef<number | null>(null);
  const liveLogCounterRef = useRef(0);
  const lastInferenceStartRef = useRef<number | null>(null);
  const trackerRef = useRef(new ByteTrackLite(0.35, 0.3, 25, 0.6));

  useEffect(() => {
    if (!hasPermission) {
      requestPermission();
    }
  }, [hasPermission, requestPermission]);

  useFocusEffect(
    React.useCallback(() => {
      ScreenOrientation.unlockAsync();
      return () => {
        ScreenOrientation.unlockAsync();
      };
    }, [])
  );

  useEffect(() => {
    let isMounted = true;
    const syncOrientation = async () => {
      const current = await ScreenOrientation.getOrientationAsync();
      if (!isMounted) {
        return;
      }
      const isLandscape = current === ScreenOrientation.Orientation.LANDSCAPE_LEFT
        || current === ScreenOrientation.Orientation.LANDSCAPE_RIGHT;
      setOrientation(isLandscape ? 'landscape' : 'portrait');
    };
    syncOrientation();
    const subscription = ScreenOrientation.addOrientationChangeListener((event) => {
      const current = event.orientationInfo.orientation;
      const isLandscape = current === ScreenOrientation.Orientation.LANDSCAPE_LEFT
        || current === ScreenOrientation.Orientation.LANDSCAPE_RIGHT;
      setOrientation(isLandscape ? 'landscape' : 'portrait');
    });
    return () => {
      isMounted = false;
      ScreenOrientation.removeOrientationChangeListener(subscription);
    };
  }, []);

  // Pause camera when screen is not focused or app is in background
  useFocusEffect(
    React.useCallback(() => {
      setIsActive(true);
      return () => setIsActive(false);
    }, [])
  );

  // Handle app state changes
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
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

  // Load TFLite model on mount
  useEffect(() => {
    const loadModel = async () => {
      const loaded = await loadYoloModel();
      setIsModelLoaded(loaded);
      isModelLoadedShared.value = loaded;
    };

    loadModel();

    return () => {
      // Clean up model when component unmounts
      if (isModelLoaded) {
        closeYoloModel();
        isModelLoadedShared.value = false;
      }
    };
  }, []);

  // Send turn signal via BLE when detections change
  useEffect(() => {
    if (lastFrameSize.width === 0) {
      return;
    }

    const turnSignalData = getTurnSignalForBLE(detections, lastFrameSize.width);
    if (turnSignalData === null) {
      return; // No update needed
    }

    // Send turn signal via BLE
    sendTurnSignal(turnSignalData.value, turnSignalData.hasBall).catch((error) => {
      console.error('❌ Failed to send turn signal via BLE:', error);
    });
  }, [detections, lastFrameSize.width]);

  const handleInferenceOnJS = async (
    rgbData: number[],
    frameWidth: number,
    frameHeight: number,
    resizedWidth: number,
    resizedHeight: number,
    padX: number,
    padY: number,
    scale: number,
    isLiveMode: boolean
  ) => {
    if (!isModelLoaded || isInferencing) {
      isInferencingShared.value = false;
      return;
    }
    if (!rgbData || rgbData.length === 0) {
      isInferencingShared.value = false;
      console.warn('Skipping inference: empty RGB buffer');
      return;
    }
    setIsInferencing(true);
    isInferencingShared.value = true;
    try {
      const tStart = nowMs();
      const lastStart = lastInferenceStartRef.current;
      lastInferenceStartRef.current = tStart;
      let tAfterPad = 0;
      let tAfterInfer = 0;
      let tAfterCorrect = 0;
      let tAfterTrack = 0;

      const padded = padToSquare(rgbData, resizedWidth, resizedHeight, padX, padY);
      tAfterPad = nowMs();
      const detections = await runYoloInference(padded, INPUT_SIZE, INPUT_SIZE);
      tAfterInfer = nowMs();
      const corrected = detections.map((det) => {
        const x = (det.x - padX) / scale;
        const y = (det.y - padY) / scale;
        const width = det.width / scale;
        const height = det.height / scale;
        return {
          ...det,
          x: Math.max(0, Math.min(frameWidth - 1, x)),
          y: Math.max(0, Math.min(frameHeight - 1, y)),
          width: Math.max(1, Math.min(frameWidth, width)),
          height: Math.max(1, Math.min(frameHeight, height)),
        };
      });
      tAfterCorrect = nowMs();
      const ballDets: Det[] = [];
      for (let i = 0; i < corrected.length; i += 1) {
        const det = corrected[i];
        if ((det.className ?? det.class) === BASKETBALL_LABEL || det.class === 0) {
          ballDets.push(detectionToDet(det));
        }
      }
      const tracks = trackerRef.current.update(ballDets);
      const bestTrack = getBestTrack(tracks);
      const tracked = bestTrack ? [trackToDetection(bestTrack)] : [];
      const ballCenterX = bestTrack ? (bestTrack.x1 + bestTrack.x2) * 0.5 : null;
      tAfterTrack = nowMs();
      setDetections(tracked);
      setBallSide(
        ballCenterX === null
          ? getBallSide(tracked, frameWidth)
          : getBallSideFromCenterX(ballCenterX, frameWidth)
      );
      setLastFrameSize({ width: frameWidth, height: frameHeight });
      setLastInferenceAt(Date.now());
      if (isLiveMode || ENABLE_TIMING_LOGS) {
        const padMs = tAfterPad - tStart;
        const inferMs = tAfterInfer - tAfterPad;
        const correctMs = tAfterCorrect - tAfterInfer;
        const trackMs = tAfterTrack - tAfterCorrect;
        const totalMs = tAfterTrack - tStart;
        const gapMs = lastStart ? tStart - lastStart : 0;
        if (ENABLE_LIVE_LOGS || ENABLE_TIMING_LOGS) {
          liveLogCounterRef.current += 1;
          if (liveLogCounterRef.current % LIVE_LOG_EVERY === 0 || ENABLE_TIMING_LOGS) {
            console.log('⏱️ Inference timings (ms):', {
              padToSquare: Math.round(padMs),
              runYoloInference: Math.round(inferMs),
              correctDetections: Math.round(correctMs),
              trackUpdate: Math.round(trackMs),
              total: Math.round(totalMs),
              sinceLastInferenceStart: Math.round(gapMs),
            });
          }
        }
        if (isLiveMode && tracked.length > 0 && ENABLE_LIVE_LOGS) {
          const now = Date.now();
          const last = lastLiveDetectionAtRef.current;
          if (last) {
            console.log('⏱️ Time between live detections (ms):', now - last);
          }
          lastLiveDetectionAtRef.current = now;
        }
      }
      if (!isLiveMode && ENABLE_LIVE_LOGS) {
        console.log('🧠 YOLO detections:', tracked.map((det) => ({
          class: det.className ?? det.class,
          confidence: Number(det.confidence.toFixed(3)),
          box: {
            x: Number(det.x.toFixed(1)),
            y: Number(det.y.toFixed(1)),
            w: Number(det.width.toFixed(1)),
            h: Number(det.height.toFixed(1)),
          },
        })));
      }
    } catch (error) {
      console.error('Inference error:', error);
    } finally {
      setIsInferencing(false);
      isInferencingShared.value = false;
    }
  };

  const runInferenceOnJS = useRunOnJS(handleInferenceOnJS, [isModelLoaded, isInferencing]);
  const updateFpsOnJS = useRunOnJS((value: number) => {
    setFps(value);
  }, []);

  const resizePlugin = useMemo(() => createResizePlugin(), []);

  const padToSquare = (
    rgbData: number[],
    width: number,
    height: number,
    padX: number,
    padY: number
  ) => {
    const size = INPUT_SIZE;
    const output = new Array<number>(size * size * 3).fill(0);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const srcIndex = (y * width + x) * 3;
        const dstIndex = ((y + padY) * size + (x + padX)) * 3;
        output[dstIndex] = rgbData[srcIndex];
        output[dstIndex + 1] = rgbData[srcIndex + 1];
        output[dstIndex + 2] = rgbData[srcIndex + 2];
      }
    }
    return output;
  };

  const handleSnapshot = async () => {
    if (!cameraRef.current || isSnapshotting || !isModelLoaded) {
      return;
    }
    setIsSnapshotting(true);
    try {
      const photo = await cameraRef.current.takePhoto({});
      const photoUri = photo.path.startsWith('file://') ? photo.path : `file://${photo.path}`;
      const origWidth = Number.isFinite(photo.width) ? photo.width : 0;
      const origHeight = Number.isFinite(photo.height) ? photo.height : 0;
      const maxSide = Math.max(origWidth, origHeight);
      const scale = maxSide > 0 ? INPUT_SIZE / maxSide : 1;
      const resizedWidth = Math.max(1, Math.round(origWidth * scale));
      const resizedHeight = Math.max(1, Math.round(origHeight * scale));
      const padX = Math.floor((INPUT_SIZE - resizedWidth) / 2);
      const padY = Math.floor((INPUT_SIZE - resizedHeight) / 2);
      const resized = await ImageManipulator.manipulateAsync(
        photoUri,
        [{ resize: { width: resizedWidth, height: resizedHeight } }],
        { format: ImageManipulator.SaveFormat.JPEG, compress: 0.9, base64: true }
      );
      if (!resized.base64) {
        throw new Error('Failed to read snapshot as base64');
      }
      const rgbData = decodeJpegToRgb(resized.base64);
      const padded = padToSquare(Array.from(rgbData), resizedWidth, resizedHeight, padX, padY);
      const results = await runYoloInference(padded, INPUT_SIZE, INPUT_SIZE);
      const corrected = results.map((det) => {
        const x = (det.x - padX) / scale;
        const y = (det.y - padY) / scale;
        const width = det.width / scale;
        const height = det.height / scale;
        return {
          ...det,
          x: Math.max(0, Math.min(origWidth - 1, x)),
          y: Math.max(0, Math.min(origHeight - 1, y)),
          width: Math.max(1, Math.min(origWidth, width)),
          height: Math.max(1, Math.min(origHeight, height)),
        };
      });
      const runAt = Date.now();
      addSnapshot({
        id: `snap-${runAt}`,
        uri: photoUri,
        detections: corrected,
        runAt,
        width: origWidth,
        height: origHeight,
      });
    } catch (error) {
      console.error('Snapshot inference failed:', error);
    } finally {
      setIsSnapshotting(false);
    }
  };

  const frameProcessor = useFrameProcessor((frame: Frame) => {
    'worklet';
    const now = Date.now();
    if (fpsLastTimestamp.value === 0) {
      fpsLastTimestamp.value = now;
    }
    fpsFrameCount.value += 1;
    const elapsed = now - fpsLastTimestamp.value;
    if (elapsed >= 1000) {
      const nextFps = Math.round((fpsFrameCount.value * 1000) / elapsed);
      fpsFrameCount.value = 0;
      fpsLastTimestamp.value = now;
      updateFpsOnJS(nextFps);
    }
    
    if (!isModelLoadedShared.value) {
      return;
    }

    // Handle single-shot inference (triggered by button)
    if (singleShotRequestId.value !== lastProcessedRequestId.value) {
      if (isInferencingShared.value) {
        return; // Skip if already inferencing
      }
      lastProcessedRequestId.value = singleShotRequestId.value;
      
      const maxSide = frame.width > frame.height ? frame.width : frame.height;
      const scale = INPUT_SIZE / maxSide;
      const resizedWidth = Math.round(frame.width * scale);
      const resizedHeight = Math.round(frame.height * scale);
      const padX = Math.floor((INPUT_SIZE - resizedWidth) / 2);
      const padY = Math.floor((INPUT_SIZE - resizedHeight) / 2);

      const rgbData = resizePlugin.resize(frame, {
        scale: { width: resizedWidth, height: resizedHeight },
        pixelFormat: 'rgb',
        dataType: 'uint8',
      });
      if (!rgbData || rgbData.length === 0) {
        return;
      }
      const length = rgbData.length;
      const rgbArray = new Array<number>(length);
      for (let i = 0; i < length; i += 1) {
        rgbArray[i] = rgbData[i];
      }
      runInferenceOnJS(
        rgbArray,
        frame.width,
        frame.height,
        resizedWidth,
        resizedHeight,
        padX,
        padY,
        scale,
        false
      );
      return;
    }

    // Handle live inference (throttled)
    if (isLiveInferenceShared.value && !isInferencingShared.value) {
      const timeSinceLastInference = now - lastLiveInferenceTime.value;
      const inferenceInterval = 1000 / LIVE_INFERENCE_FPS;
      
      if (timeSinceLastInference >= inferenceInterval) {
        lastLiveInferenceTime.value = now;

        const maxSide = frame.width > frame.height ? frame.width : frame.height;
        const scale = INPUT_SIZE / maxSide;
        const resizedWidth = Math.round(frame.width * scale);
        const resizedHeight = Math.round(frame.height * scale);
        const padX = Math.floor((INPUT_SIZE - resizedWidth) / 2);
        const padY = Math.floor((INPUT_SIZE - resizedHeight) / 2);

        const rgbData = resizePlugin.resize(frame, {
          scale: { width: resizedWidth, height: resizedHeight },
          pixelFormat: 'rgb',
          dataType: 'uint8',
        });
        if (!rgbData || rgbData.length === 0) {
          return;
        }
        const length = rgbData.length;
        const rgbArray = new Array<number>(length);
        for (let i = 0; i < length; i += 1) {
          rgbArray[i] = rgbData[i];
        }
        runInferenceOnJS(
          rgbArray,
          frame.width,
          frame.height,
          resizedWidth,
          resizedHeight,
          padX,
          padY,
          scale,
          true
        );
      }
    }
  }, [singleShotRequestId, lastProcessedRequestId, runInferenceOnJS]);


  if (!hasPermission) {
    return (
      <ThemedView style={styles.container}>
        <ThemedText style={styles.message}>Camera permission is required</ThemedText>
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

  return (
    <View
      style={styles.container}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setPreviewSize({ width, height });
      }}
    >
      <Camera
        style={styles.camera}
        device={device}
        ref={cameraRef}
        isActive={isActive}
        frameProcessor={frameProcessor}
        enableFpsGraph={false}
        pixelFormat="yuv"
        photo={true}
      />
      {/* Detection boxes overlay */}
      {detections.length > 0 && previewSize.width > 0 && previewSize.height > 0 && lastFrameSize.width > 0 && lastFrameSize.height > 0 && (
        <View style={styles.detectionOverlay} pointerEvents="none">
          {detections.map((det, idx) => {
            // Calculate scale factor from frame to preview
            const frameAspect = lastFrameSize.width / lastFrameSize.height;
            const previewAspect = previewSize.width / previewSize.height;
            
            let scaleX: number;
            let scaleY: number;
            let offsetX = 0;
            let offsetY = 0;
            
            if (frameAspect > previewAspect) {
              // Frame is wider - letterboxing on top/bottom
              scaleX = previewSize.width / lastFrameSize.width;
              scaleY = scaleX;
              offsetY = (previewSize.height - lastFrameSize.height * scaleY) / 2;
            } else {
              // Frame is taller - letterboxing on left/right
              scaleY = previewSize.height / lastFrameSize.height;
              scaleX = scaleY;
              offsetX = (previewSize.width - lastFrameSize.width * scaleX) / 2;
            }
            
            // Map detection coordinates to preview coordinates
            const left = offsetX + det.x * scaleX;
            const top = offsetY + det.y * scaleY;
            const width = det.width * scaleX;
            const height = det.height * scaleY;
            
            return (
              <View
                key={`${det.class}-${idx}-${det.x}-${det.y}`}
                style={[
                  styles.detectionBox,
                  {
                    left: Math.max(0, left),
                    top: Math.max(0, top),
                    width: Math.max(1, Math.min(width, previewSize.width)),
                    height: Math.max(1, Math.min(height, previewSize.height)),
                  },
                ]}
              >
                <ThemedText style={styles.detectionLabel}>
                  {det.className ?? det.class} {(det.confidence * 100).toFixed(0)}%
                </ThemedText>
              </View>
            );
          })}
        </View>
      )}
      <Pressable style={styles.backButton} onPress={() => router.back()} pointerEvents="auto">
        <ThemedText style={styles.backButtonText}>← Back</ThemedText>
      </Pressable>
      <View style={styles.overlay} pointerEvents="box-none">
        {isModelLoaded && (
          <ThemedText style={styles.modelStatus}>Model Loaded ✓</ThemedText>
        )}
        <View style={styles.toggleContainer} pointerEvents="auto">
          <ThemedText style={styles.toggleLabel}>Live Inference ({LIVE_INFERENCE_FPS} FPS)</ThemedText>
          <Switch
            value={isLiveInference}
            onValueChange={(value) => {
              setIsLiveInference(value);
              isLiveInferenceShared.value = value;
              if (!value) {
                lastLiveInferenceTime.value = 0; // Reset timer when turning off
              }
            }}
            disabled={!isModelLoaded}
            trackColor={{ false: '#767577', true: '#81b0ff' }}
            thumbColor={isLiveInference ? '#f5dd4b' : '#f4f3f4'}
          />
        </View>
        <Pressable
          style={styles.button}
          onPress={() => {
            if (!isModelLoaded || isInferencing) {
              return;
            }
            singleShotRequestId.value += 1;
            handleSnapshot();
          }}
          pointerEvents="auto"
        >
          <ThemedText style={styles.buttonText}>
            {isSnapshotting ? 'Saving…' : isInferencing ? 'Running…' : 'Snap Inference'}
          </ThemedText>
        </Pressable>
        <ThemedText style={styles.debugText}>
          Last inference: {lastInferenceAt ? new Date(lastInferenceAt).toLocaleTimeString() : '—'}
        </ThemedText>
        <ThemedText style={styles.debugText}>
          Detections: {detections.length}
        </ThemedText>
      </View>
      {ballSide && (
        <View style={styles.arrowOverlay} pointerEvents="none">
          <ThemedText style={styles.arrowText}>
            {ballSide === 'left' ? '⬅︎' : ballSide === 'right' ? '➡︎' : '⬍'}
          </ThemedText>
        </View>
      )}
      <View style={styles.fpsBadge} pointerEvents="none">
        <ThemedText style={styles.fpsText}>{fps} FPS</ThemedText>
      </View>
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
  backButton: {
    position: 'absolute',
    top: 44,
    left: 24,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  fpsBadge: {
    position: 'absolute',
    left: 24,
    bottom: 24,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  fpsText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
  arrowOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowText: {
    fontSize: 48,
    color: 'white',
    textShadowColor: 'rgba(0, 0, 0, 0.8)',
    textShadowOffset: { width: -1, height: 1 },
    textShadowRadius: 6,
  },
  backButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: 'white',
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: -1, height: 1 },
    textShadowRadius: 10,
  },
  message: {
    fontSize: 18,
    textAlign: 'center',
    marginBottom: 20,
  },
  loader: {
    marginTop: 20,
  },
  modelStatus: {
    fontSize: 14,
    color: 'green',
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: -1, height: 1 },
    textShadowRadius: 10,
    marginTop: 10,
  },
  debugText: {
    fontSize: 12,
    color: 'white',
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: -1, height: 1 },
    textShadowRadius: 10,
    marginTop: 6,
  },
  button: {
    marginTop: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  buttonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
  toggleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    gap: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  toggleLabel: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
  detectionOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  detectionBox: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: 'rgba(0, 255, 0, 0.9)',
    backgroundColor: 'rgba(0, 0, 0, 0.1)',
  },
  detectionLabel: {
    color: 'white',
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 4,
    paddingVertical: 2,
    backgroundColor: 'rgba(0, 128, 0, 0.8)',
    textShadowColor: 'rgba(0, 0, 0, 0.8)',
    textShadowOffset: { width: -1, height: 1 },
    textShadowRadius: 2,
  },
});
