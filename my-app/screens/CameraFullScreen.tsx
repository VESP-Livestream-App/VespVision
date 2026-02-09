import useBle from '@/app/hooks/use-ble';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { getBallSide, type BallSide } from '@/modules/ballDirection';
import { sendTurnSignal } from '@/modules/bleClient';
import { getBLEControlService } from '@/modules/bleControlService';
import { getTurnSignalForBLE } from '@/modules/bleTurnSignal';
import { ControlLoop } from '@/modules/controlLoop';
import { addSnapshot } from '@/modules/snapshotStore';
import { inferenceQueue } from '@/modules/inferenceQueue';
import { closeYoloModel, loadYoloModel } from '@/modules/yoloModel';
import { getYOLOInputSize, YOLO_INPUT_SIZE, type Detection } from '@/modules/yoloUtils';
import { useFocusEffect } from '@react-navigation/native';
import * as ImageManipulator from 'expo-image-manipulator';
import { useRouter } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Switch, View } from 'react-native';
import {
  Camera,
  Frame,
  useCameraDevice,
  useCameraPermission,
  useFrameProcessor,
} from 'react-native-vision-camera';
import { useRunOnJS, useSharedValue } from 'react-native-worklets-core';
import { createResizePlugin } from 'vision-camera-resize-plugin';

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

export default function CameraFullScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const router = useRouter();
  const cameraRef = useRef<Camera>(null);
  const device = useCameraDevice('back');
  const isMountedRef = useRef(true); // Track if component is mounted
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
  const [showBoxes, setShowBoxes] = useState(false); // Toggle for box rendering
  const singleShotRequestId = useSharedValue(0);
  const lastProcessedRequestId = useSharedValue(0);
  const fpsFrameCount = useSharedValue(0);
  const fpsLastTimestamp = useSharedValue(0);
  const isModelLoadedShared = useSharedValue(false);
  const isLiveInferenceShared = useSharedValue(false);
  const lastLiveInferenceTime = useSharedValue(0);
  const isInferencingShared = useSharedValue(false);
  const isSnapshottingShared = useSharedValue(false); // Track snapshot state in worklet
  const yoloInputSize = useSharedValue(YOLO_INPUT_SIZE); // Make accessible in worklet

  // BLE integration for control loop
  const {
    connectedId,
    currentPos,
    sendAngleTime,
  } = useBle();

  // Control loop instance
  const controlLoopRef = useRef<ControlLoop | null>(null);
  const bleServiceRef = useRef(getBLEControlService());

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
      // Clean up on unmount
      isMountedRef.current = false;
      // Clear inference queue to prevent callbacks after unmount
      inferenceQueue.clear();
      // Clean up model when component unmounts
      if (isModelLoaded) {
        closeYoloModel();
        isModelLoadedShared.value = false;
      }
    };
  }, []);

  // Initialize control loop and BLE service
  useEffect(() => {
    // Initialize control loop with default config 
    controlLoopRef.current = new ControlLoop({
      fieldOfView: 70,
      servoSpeed: 60.0,
      controllerGain: 25.0,
      frameWidth: lastFrameSize.width || 640,
      planeDegrees: 180,
      edgeViewRedundancyFactor: 0.25,
    });

    // Initialize BLE service with sendAngleTime callback
    bleServiceRef.current.initialize(async (deviceId, angle, timeMs) => {
      await sendAngleTime(deviceId, angle, timeMs);
    });

    return () => {
      // Cleanup
      controlLoopRef.current?.reset();
      bleServiceRef.current.reset();
    };
  }, [sendAngleTime]);

  // Update BLE service when connection changes
  useEffect(() => {
    bleServiceRef.current.setConnectedDevice(connectedId);
  }, [connectedId]);

  // Update control loop frame width when it changes
  useEffect(() => {
    if (controlLoopRef.current && lastFrameSize.width > 0) {
      // Recreate control loop with new frame width
      controlLoopRef.current = new ControlLoop({
        fieldOfView: 70,
        servoSpeed: 60.0,
        controllerGain: 25.0,
        frameWidth: lastFrameSize.width,
        planeDegrees: 180,
        edgeViewRedundancyFactor: 0.25,
      });
    }
  }, [lastFrameSize.width]);

  // Send turn signal via BLE when detections change (legacy - can be removed if using control loop)
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

  // Control loop: process detections and send servo commands
  useEffect(() => {
    if (!controlLoopRef.current || !bleServiceRef.current.isConnected()) {
      return;
    }

    if (lastFrameSize.width === 0 || currentPos === null) {
      return;
    }

    // Run control loop update
    const command = controlLoopRef.current.update(
      detections,
      currentPos,
      lastFrameSize.width
    );

    if (command) {
      // Send command via BLE
      bleServiceRef.current.sendCommand(command).catch((error) => {
        console.error('❌ Failed to send control command via BLE:', error);
      });
    }
  }, [detections]);

  const handleInferenceOnJS = async (
    rgbData: number[],
    frameWidth: number,
    frameHeight: number,
    resizedWidth: number,
    resizedHeight: number,
    padX: number,
    padY: number,
    scale: number
  ) => {
    const requestStartTime = Date.now();
    
    if (!isModelLoaded) {
      isInferencingShared.value = false;
      return;
    }
    if (!rgbData || rgbData.length === 0) {
      isInferencingShared.value = false;
      console.warn('Skipping inference: empty RGB buffer');
      return;
    }

    // Preprocess frame (fast, synchronous)
    const preprocessStart = Date.now();
    const padded = padToSquare(rgbData, resizedWidth, resizedHeight, padX, padY);
    const preprocessTime = Date.now() - preprocessStart;

    // Queue inference (non-blocking - returns immediately)
    // The queue will process this in the background and call the callback when done
    // DON'T set isInferencing here - let the queue handle concurrency
    const queueSize = inferenceQueue.size();
    const isBusy = inferenceQueue.isBusy();
    const enqueueTime = Date.now();
    
    if (queueSize > 0 || isBusy || preprocessTime > 5) {
      console.log(`📥 [Queue Status]`, {
        size: queueSize,
        busy: isBusy,
        preprocessTime: `${preprocessTime}ms`,
      });
    }
    
    // Set inferencing state only when queue is actually processing
    // This prevents blocking the frame processor
    if (!isBusy && queueSize === 0) {
      isInferencingShared.value = true;
      setIsInferencing(true);
    }
    
    inferenceQueue.enqueue(
      padded,
      frameWidth,
      frameHeight,
      resizedWidth,
      resizedHeight,
      padX,
      padY,
      scale
    ).then((detections) => {
      // Safety check: Don't update state if component is unmounted
      if (!isMountedRef.current) {
        return;
      }
      
      // This callback runs when inference completes (non-blocking)
      // Detections are already corrected by the queue
      const callbackStart = Date.now();
      const totalTime = callbackStart - requestStartTime;
      const queueTime = callbackStart - enqueueTime;
      
      // Update state (measure render time)
      const stateUpdateStart = Date.now();
      setDetections(detections);
      setBallSide(getBallSide(detections, frameWidth));
      setLastFrameSize({ width: frameWidth, height: frameHeight });
      setLastInferenceAt(Date.now());
      const stateUpdateTime = Date.now() - stateUpdateStart;
      
      // Log end-to-end timing (including state update)
      console.log(`✅ [Inference Complete]`, {
        totalTime: `${totalTime}ms`,
        queueTime: `${queueTime}ms`,
        stateUpdate: `${stateUpdateTime}ms`,
        detections: detections.length,
      });
      
      console.log('🧠 YOLO detections:', detections.map((det) => ({
        class: det.className ?? det.class,
        confidence: Number(det.confidence.toFixed(3)),
        box: {
          x: Number(det.x.toFixed(1)),
          y: Number(det.y.toFixed(1)),
          w: Number(det.width.toFixed(1)),
          h: Number(det.height.toFixed(1)),
        },
      })));
      setIsInferencing(false);
      isInferencingShared.value = false;
    }).catch((error) => {
      // Safety check: Don't update state if component is unmounted
      if (!isMountedRef.current) {
        return;
      }
      
      const errorTime = Date.now();
      const totalTime = errorTime - requestStartTime;
      console.error(`❌ [Inference Error] after ${totalTime}ms:`, error);
      setIsInferencing(false);
      isInferencingShared.value = false;
    });
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
    const size = getYOLOInputSize(); // Use configurable input size
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
    isSnapshottingShared.value = true; // Prevent frame processor from triggering
    try {
      const photo = await cameraRef.current.takePhoto({});
      const photoUri = photo.path.startsWith('file://') ? photo.path : `file://${photo.path}`;
      const origWidth = Number.isFinite(photo.width) ? photo.width : 0;
      const origHeight = Number.isFinite(photo.height) ? photo.height : 0;
      const maxSide = Math.max(origWidth, origHeight);
      const scale = maxSide > 0 ? YOLO_INPUT_SIZE / maxSide : 1;
      const resizedWidth = Math.max(1, Math.round(origWidth * scale));
      const resizedHeight = Math.max(1, Math.round(origHeight * scale));
      const padX = Math.floor((YOLO_INPUT_SIZE - resizedWidth) / 2);
      const padY = Math.floor((YOLO_INPUT_SIZE - resizedHeight) / 2);
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
      
      // Use inference queue (non-blocking, but we wait for snapshot result)
      const results = await inferenceQueue.enqueue(
        padded,
        origWidth,
        origHeight,
        resizedWidth,
        resizedHeight,
        padX,
        padY,
        scale
      );
      
      // Results are already corrected by the queue
      const corrected = results;
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
      isSnapshottingShared.value = false; // Re-enable frame processor
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
    // Skip if snapshot is in progress (handleSnapshot handles it)
    if (singleShotRequestId.value !== lastProcessedRequestId.value && !isSnapshottingShared.value) {
      // Don't block on isInferencing - queue handles frame dropping
      lastProcessedRequestId.value = singleShotRequestId.value;
      
      const maxSide = frame.width > frame.height ? frame.width : frame.height;
      const inputSize = yoloInputSize.value; // Access shared value in worklet
      const scale = inputSize / maxSide;
      const resizedWidth = Math.round(frame.width * scale);
      const resizedHeight = Math.round(frame.height * scale);
      const padX = Math.floor((inputSize - resizedWidth) / 2);
      const padY = Math.floor((inputSize - resizedHeight) / 2);

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
        scale
      );
      return;
    }

    // Handle live inference - MAXED OUT to match camera frame rate
    // Non-blocking queue allows maximum rate - queue will drop old frames automatically
    // Don't check isInferencingShared - queue handles concurrency and frame dropping
    if (isLiveInferenceShared.value) {
      const timeSinceLastInference = now - lastLiveInferenceTime.value;
      // 33ms = ~30 FPS (matches camera), 16ms = 60 FPS (if device can handle)
      // Queue will automatically drop frames if inference can't keep up
      const inferenceInterval = 33; // 33ms = ~30 FPS (MAXED OUT)
      
      if (timeSinceLastInference >= inferenceInterval) {
        const intervalActual = timeSinceLastInference;
        lastLiveInferenceTime.value = now;
        
        // Log timing: interval between inference requests
        console.log(`📊 [Frame Timing]`, {
          interval: `${intervalActual}ms`,
          target: `${inferenceInterval}ms`,
          fps: `${Math.round(1000 / intervalActual)} FPS`,
        });

        const maxSide = frame.width > frame.height ? frame.width : frame.height;
        const inputSize = yoloInputSize.value; // Access shared value in worklet
        const scale = inputSize / maxSide;
        const resizedWidth = Math.round(frame.width * scale);
        const resizedHeight = Math.round(frame.height * scale);
        const padX = Math.floor((inputSize - resizedWidth) / 2);
        const padY = Math.floor((inputSize - resizedHeight) / 2);

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
          scale
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
      {showBoxes && detections.length > 0 && previewSize.width > 0 && previewSize.height > 0 && lastFrameSize.width > 0 && lastFrameSize.height > 0 && (
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
          <ThemedText style={styles.toggleLabel}>Live Inference</ThemedText>
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
        <View style={styles.toggleContainer} pointerEvents="auto">
          <ThemedText style={styles.toggleLabel}>Show Boxes</ThemedText>
          <Switch
            value={showBoxes}
            onValueChange={setShowBoxes}
            trackColor={{ false: '#767577', true: '#81b0ff' }}
            thumbColor={showBoxes ? '#f5dd4b' : '#f4f3f4'}
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
