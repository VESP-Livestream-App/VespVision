import useBle from '@/app/hooks/use-ble';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { getBallSide, type BallSide } from '@/modules/ballDirection';
import { sendTurnSignal } from '@/modules/bleClient';
import { getBLEControlService } from '@/modules/bleControlService';
import { getTurnSignalForBLE } from '@/modules/bleTurnSignal';
import { ControlLoop } from '@/modules/controlLoop';
import { getPidTelemetryCsvPath, preparePidTelemetryCsvForExport } from '@/modules/pidTelemetry';
import { addSnapshot } from '@/modules/snapshotStore';
import { normalizeOutputLayout, runYoloInference } from '@/modules/yoloInference';
import { closeYoloModel, loadYoloModel } from '@/modules/yoloModel';
import type { Detection } from '@/modules/yoloUtils';
import { parseYOLOOutput } from '@/modules/yoloUtils';
import { useFocusEffect } from '@react-navigation/native';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Sharing from 'expo-sharing';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as ScreenOrientation from 'expo-screen-orientation';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Pressable, StyleSheet, Switch, View } from 'react-native';
import {
  Camera,
  Frame,
  useCameraDevice,
  useCameraPermission,
  useFrameProcessor,
  VisionCameraProxy,
} from 'react-native-vision-camera';
import { useRunOnJS, useSharedValue } from 'react-native-worklets-core';
import { createResizePlugin } from 'vision-camera-resize-plugin';

const CONTROL_FIELD_OF_VIEW = 70;
const BALL_LABELS = ['sports ball', 'basketball', 'soccer ball', 'tennis ball'];
const MIN_DETECTION_CONFIDENCE = 0.7;
const STREAM_INFERENCE_LOG_INTERVAL_MS = 2000;

const getDetectedBallAngleFromDetections = (
  allDetections: Detection[],
  frameWidth: number,
  currentServoPos: number | null
): number | null => {
  if (currentServoPos === null || frameWidth <= 0) {
    return null;
  }
  const bestBall = allDetections
    .filter((det) => BALL_LABELS.includes(String(det.className ?? det.class).toLowerCase()))
    .sort((a, b) => b.confidence - a.confidence)[0];
  if (!bestBall) {
    return null;
  }
  const ballCenterX = bestBall.x + bestBall.width / 2;
  const fovAngle = (ballCenterX / frameWidth) * CONTROL_FIELD_OF_VIEW;
  return currentServoPos - CONTROL_FIELD_OF_VIEW / 2 + fovAngle;
};

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

type CameraFullScreenProps = {
  mode?: 'test' | 'stream';
};

export default function CameraFullScreen({ mode = 'test' }: CameraFullScreenProps) {
  const isStreamMode = mode === 'stream';
  const { hasPermission, requestPermission } = useCameraPermission();
  const router = useRouter();
  const params = useLocalSearchParams<{ minBound?: string; maxBound?: string }>();
  const cameraRef = useRef<Camera>(null);
  const device = useCameraDevice('back');
  const deviceFieldOfView = device?.formats?.[0]?.fieldOfView ?? CONTROL_FIELD_OF_VIEW;

  useEffect(() => {
    const rawFov = device?.formats?.[0]?.fieldOfView;
    // const usingFallback = rawFov === undefined || rawFov === null;
    // console.log(
    //   `📷 Camera FOV selected: ${deviceFieldOfView.toFixed(2)}° (${usingFallback ? 'fallback' : 'device format'})`,
    //   { rawFormatFieldOfView: rawFov ?? null }
    // );
    void rawFov;
    void deviceFieldOfView;
  }, [device, deviceFieldOfView]);
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
  const [isLiveInference, setIsLiveInference] = useState(isStreamMode);
  const minBound = useMemo(() => {
    const parsed = Number(params.minBound);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(180, parsed)) : 0;
  }, [params.minBound]);
  const maxBound = useMemo(() => {
    const parsed = Number(params.maxBound);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(180, parsed)) : 180;
  }, [params.maxBound]);
  const servoRange = useMemo(() => {
    const low = Math.min(minBound, maxBound);
    const high = Math.max(minBound, maxBound);
    if (high - low < 1) {
      return { min: 0, max: 180 };
    }
    return { min: low, max: high };
  }, [minBound, maxBound]);
  const singleShotRequestId = useSharedValue(0);
  const lastProcessedRequestId = useSharedValue(0);
  const fpsFrameCount = useSharedValue(0);
  const fpsLastTimestamp = useSharedValue(0);
  const isModelLoadedShared = useSharedValue(false);
  const isLiveInferenceShared = useSharedValue(false);
  const lastLiveInferenceTime = useSharedValue(0);
  const isInferencingShared = useSharedValue(false);
  const isInferenceRunningJSShared = useSharedValue(false);
  const inferenceStartedAt = useSharedValue(0);
  const lastInferenceDurationShared = useSharedValue(40);
  const INFERENCE_WATCHDOG_MS = 1200;
  
  const INFERENCE_PATH_LOG_INTERVAL_MS = 3000;
  const pluginSuccessCountShared = useSharedValue(0);
  const pluginEmptyCountShared = useSharedValue(0);
  const fallbackCountShared = useSharedValue(0);
  const inferencePathWindowStartMsShared = useSharedValue(0);

  useEffect(() => {
    if (isStreamMode) {
      // Enforce always-on live inference in production streaming mode.
      setIsLiveInference(true);
    }
  }, [isStreamMode]);

  useEffect(() => {
    isLiveInferenceShared.value = isLiveInference;
    if (!isLiveInference) {
      lastLiveInferenceTime.value = 0;
    }
  }, [isLiveInference]);

  // BLE integration for control loop
  const {
    connectedId,
    currentPos,
    sendAngleTime,
  } = useBle();

  // Control loop instance
  const controlLoopRef = useRef<ControlLoop | null>(null);
  const bleServiceRef = useRef(getBLEControlService());
  const lastSentServoCommandAngleRef = useRef<number | null>(null);
  const lastStreamInferenceLogAtRef = useRef(0);

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

  useEffect(() => {
    const id = setInterval(() => {
      console.log(`📷 [CameraFullScreen] ${new Date().toISOString()} FPS=${fps}`);
    }, 10000);
    return () => clearInterval(id);
  }, [fps]);

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

  // Initialize control loop and BLE service
  useEffect(() => {
    // Initialize control loop with default config 
    controlLoopRef.current = new ControlLoop({
      fieldOfView: deviceFieldOfView,
      servoSpeed: 40.0,
      kp: 25.0,
      frameWidth: lastFrameSize.width || 640,
      planeDegrees: 180,
      minServoAngle: servoRange.min,
      maxServoAngle: servoRange.max,
      edgeViewRedundancyFactor: 0.25,
      searchModeDelayMs: 1500,
    });

    // Initialize BLE service with sendAngleTime callback
    bleServiceRef.current.initialize(async (deviceId, angle, timeMs) => {
      await sendAngleTime(deviceId, angle, timeMs);
    });
    // console.log(`📄 PID telemetry CSV will be written to: ${getPidTelemetryCsvPath()}`);
    void getPidTelemetryCsvPath;

    return () => {
      // Cleanup
      controlLoopRef.current?.reset();
      bleServiceRef.current.reset();
    };
  }, [sendAngleTime, deviceFieldOfView, servoRange.min, servoRange.max]);

  // Update BLE service when connection changes
  useEffect(() => {
    bleServiceRef.current.setConnectedDevice(connectedId);
  }, [connectedId]);

  // Update control loop frame width when it changes
  useEffect(() => {
    if (controlLoopRef.current && lastFrameSize.width > 0) {
      // Recreate control loop with new frame width
      controlLoopRef.current = new ControlLoop({
        fieldOfView: deviceFieldOfView,
        servoSpeed: 40.0,
        kp: 25.0,
        frameWidth: lastFrameSize.width,
        planeDegrees: 180,
        minServoAngle: servoRange.min,
        maxServoAngle: servoRange.max,
        edgeViewRedundancyFactor: 0.25,
        searchModeDelayMs: 1500,
      });
    }
  }, [lastFrameSize.width, deviceFieldOfView, servoRange.min, servoRange.max]);

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
      // console.error('❌ Failed to send turn signal via BLE:', error);
      void error;
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
      lastFrameSize.width,
      deviceFieldOfView
    );

    if (command) {
      // Send command via BLE
      bleServiceRef.current.sendCommand(command).then((wasSent) => {
        if (wasSent) {
          lastSentServoCommandAngleRef.current = command.angle;
        } else {
          // console.log('⚠️ Control command not sent (rate limit/disconnected).');
        }
      }).catch((error) => {
        // console.error('❌ Failed to send control command via BLE:', error);
        void error;
      });
    }
  }, [detections]);

  const handleInferenceOnJS = async (
    payload: number[],
    frameWidth: number,
    frameHeight: number,
    resizedWidth: number,
    resizedHeight: number,
    padX: number,
    padY: number,
    scale: number,
    fromNativeFrame: boolean,
    isLiveMode: boolean
  ) => {
    const t0 = Date.now();
    isInferenceRunningJSShared.value = true;
    if (!isModelLoaded) {
      // console.log('❌ Inference skipped: model not loaded');
      isInferencingShared.value = false;
      isInferenceRunningJSShared.value = false;
      inferenceStartedAt.value = 0;
      return;
    }
    if (!payload || payload.length === 0) {
      // console.warn('❌ Inference skipped: empty payload');
      isInferencingShared.value = false;
      isInferenceRunningJSShared.value = false;
      inferenceStartedAt.value = 0;
      return;
    }
    if (!isLiveMode) {
      setIsInferencing(true);
    }
    try {
      let detections: Detection[];
      if (fromNativeFrame) {
        const normalized = normalizeOutputLayout(payload);
        detections = parseYOLOOutput(normalized, 640, 640, {
          inputSize: 640,
          numClasses: 2,
          confidenceThreshold: 0.25,
          nmsThreshold: 0.4,
          applySigmoid: false,
          boxIsNormalized: true,
        });
      } else {
        const padded = padToSquare(payload, resizedWidth, resizedHeight, padX, padY);
        detections = await runYoloInference(padded, 640, 640);
      }
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
      const detectedBallAngle = getDetectedBallAngleFromDetections(corrected, frameWidth, currentPos);
      // console.log(`🔎 [InferenceRaw] detections=${JSON.stringify(detections)}`);
      void detectedBallAngle;
      // Temporarily disabled during performance testing.
      // appendPidTelemetryRow(detectedBallAngle, lastSentServoCommandAngleRef.current).catch((error) => {
      //   console.error('❌ Failed to append PID telemetry row:', error);
      // });
      setDetections(corrected);
      setBallSide(getBallSide(corrected, frameWidth));
      setLastFrameSize({ width: frameWidth, height: frameHeight });
      setLastInferenceAt(Date.now());
    } catch (error) {
      // console.error('❌ Inference error:', error);
      void error;
    } finally {
      const dt = Date.now() - t0;
      if (isStreamMode && isLiveMode) {
        const now = Date.now();
        if (now - lastStreamInferenceLogAtRef.current >= STREAM_INFERENCE_LOG_INTERVAL_MS) {
          lastStreamInferenceLogAtRef.current = now;
          console.log(
            `📡 [StreamInference] ${new Date(now).toISOString()} detections=${detections.length} duration=${dt}ms`
          );
        }
      }
      // Keep true runtime (no upper cap) so pacing reflects actual inference cost.
      lastInferenceDurationShared.value = Math.max(20, dt);
      if (!isLiveMode) {
        setIsInferencing(false);
      }
      isInferencingShared.value = false;
      isInferenceRunningJSShared.value = false;
      inferenceStartedAt.value = 0;
    }
  };

  const runInferenceOnJS = useRunOnJS(handleInferenceOnJS, [isModelLoaded, currentPos]);
  const publishNoDetectionsOnJS = useRunOnJS((frameWidth: number, frameHeight: number) => {
    setDetections([]);
    setBallSide(null);
    setLastFrameSize({ width: frameWidth, height: frameHeight });
    setLastInferenceAt(Date.now());
  }, []);
  const updateFpsOnJS = useRunOnJS((value: number) => {
    setFps(value);
  }, []);
  const reportInferencePathStatsOnJS = useRunOnJS((
    pluginSuccess: number,
    pluginEmpty: number,
    fallback: number,
    windowMs: number,
    lastInferenceMs: number
  ) => {
    const total = pluginSuccess + pluginEmpty;
    if (total <= 0) {
      return;
    }
    // const pluginRate = ((pluginSuccess / total) * 100).toFixed(1);
    // console.log(
    //   `📈 [InferencePath] ${windowMs}ms window | plugin_ok=${pluginSuccess} plugin_empty=${pluginEmpty} fallback=${fallback} plugin_ok_rate=${pluginRate}% last_inference=${lastInferenceMs}ms`
    // );
    void windowMs;
    void lastInferenceMs;
    void pluginSuccess;
    void pluginEmpty;
    void fallback;
    void total;
  }, []);

  const resizePlugin = useMemo(() => createResizePlugin(), []);
  const runYOLOFromFramePlugin = useMemo(
    () => VisionCameraProxy.initFrameProcessorPlugin('runYOLOFromFrame', {}),
    []
  );

  useEffect(() => {
    // if (runYOLOFromFramePlugin) {
    //   console.log('LOG  ✅ Native frame plugin (runYOLOFromFrame) loaded — using fast inference path');
    // } else {
    //   console.log('LOG  ⚠️ Native frame plugin not available — using bridge path (slower). Rebuild iOS app with plugin.');
    // }
    void runYOLOFromFramePlugin;
  }, [runYOLOFromFramePlugin]);

  const padToSquare = (
    rgbData: number[],
    width: number,
    height: number,
    padX: number,
    padY: number
  ) => {
    const size = 640;
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
      const scale = maxSide > 0 ? 640 / maxSide : 1;
      const resizedWidth = Math.max(1, Math.round(origWidth * scale));
      const resizedHeight = Math.max(1, Math.round(origHeight * scale));
      const padX = Math.floor((640 - resizedWidth) / 2);
      const padY = Math.floor((640 - resizedHeight) / 2);
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
      const results = await runYoloInference(padded, 640, 640);
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
      const filtered = corrected.filter((det) => det.confidence >= MIN_DETECTION_CONFIDENCE);
      const runAt = Date.now();
      addSnapshot({
        id: `snap-${runAt}`,
        uri: photoUri,
        detections: filtered,
        runAt,
        width: origWidth,
        height: origHeight,
      });
    } catch (error) {
      // console.error('Snapshot inference failed:', error);
      void error;
    } finally {
      setIsSnapshotting(false);
    }
  };

  const frameProcessor = useFrameProcessor((frame: Frame) => {
    'worklet';
    const now = Date.now();
    const pathTotal = pluginSuccessCountShared.value + pluginEmptyCountShared.value;
    if (pathTotal > 0) {
      if (inferencePathWindowStartMsShared.value === 0) {
        inferencePathWindowStartMsShared.value = now;
      }
      const windowMs = now - inferencePathWindowStartMsShared.value;
      if (windowMs >= INFERENCE_PATH_LOG_INTERVAL_MS) {
        reportInferencePathStatsOnJS(
          pluginSuccessCountShared.value,
          pluginEmptyCountShared.value,
          fallbackCountShared.value,
          windowMs,
          Math.round(lastInferenceDurationShared.value)
        );
        pluginSuccessCountShared.value = 0;
        pluginEmptyCountShared.value = 0;
        fallbackCountShared.value = 0;
        inferencePathWindowStartMsShared.value = now;
      }
    }
    if (
      isInferencingShared.value &&
      !isInferenceRunningJSShared.value &&
      inferenceStartedAt.value > 0 &&
      now - inferenceStartedAt.value > INFERENCE_WATCHDOG_MS
    ) {
      isInferencingShared.value = false;
      inferenceStartedAt.value = 0;
    }
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
      if (isInferencingShared.value || isInferenceRunningJSShared.value) {
        return; // Skip if already inferencing
      }
      lastProcessedRequestId.value = singleShotRequestId.value;
      isInferencingShared.value = true;
      inferenceStartedAt.value = now;

      const maxSide = frame.width > frame.height ? frame.width : frame.height;
      const scale = 640 / maxSide;
      const resizedWidth = Math.round(frame.width * scale);
      const resizedHeight = Math.round(frame.height * scale);
      const padX = Math.floor((640 - resizedWidth) / 2);
      const padY = Math.floor((640 - resizedHeight) / 2);

      if (runYOLOFromFramePlugin) {
        const rawOutput = runYOLOFromFramePlugin.call(frame) as number[] | undefined;
        if (Array.isArray(rawOutput)) {
          if (rawOutput.length > 0) {
            pluginSuccessCountShared.value += 1;
            runInferenceOnJS(
              rawOutput,
              frame.width,
              frame.height,
              resizedWidth,
              resizedHeight,
              padX,
              padY,
              scale,
              true,
              false
            );
            return;
          }
          // Empty array from native path means "no detections", not plugin failure.
          pluginEmptyCountShared.value += 1;
          publishNoDetectionsOnJS(frame.width, frame.height);
          isInferencingShared.value = false;
          inferenceStartedAt.value = 0;
          return;
        }
        // Null/undefined means plugin failed to produce output.
        fallbackCountShared.value += 1;
        // Fall through to resize + bridge path.
      } else {
        fallbackCountShared.value += 1;
      }

      const rgbData = resizePlugin.resize(frame, {
        scale: { width: resizedWidth, height: resizedHeight },
        pixelFormat: 'rgb',
        dataType: 'uint8',
      });
      if (!rgbData || rgbData.length === 0) {
        isInferencingShared.value = false;
        inferenceStartedAt.value = 0;
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
        false,
        false
      );
      return;
    }

    // Handle live inference with adaptive pacing.
    if (isLiveInferenceShared.value && !isInferencingShared.value && !isInferenceRunningJSShared.value) {
      const timeSinceLastInference = now - lastLiveInferenceTime.value;
      const inferenceInterval = Math.max(100, lastInferenceDurationShared.value);
      
      if (timeSinceLastInference >= inferenceInterval) {
        // console.log("🔍 [CameraFullScreen] Inference interval:", timeSinceLastInference, inferenceInterval);
        lastLiveInferenceTime.value = now;
        isInferencingShared.value = true;
        inferenceStartedAt.value = now;

        const maxSide = frame.width > frame.height ? frame.width : frame.height;
        const scale = 640 / maxSide;
        const resizedWidth = Math.round(frame.width * scale);
        const resizedHeight = Math.round(frame.height * scale);
        const padX = Math.floor((640 - resizedWidth) / 2);
        const padY = Math.floor((640 - resizedHeight) / 2);

        if (runYOLOFromFramePlugin) {
          const rawOutput = runYOLOFromFramePlugin.call(frame) as number[] | undefined;
          if (Array.isArray(rawOutput)) {
            if (rawOutput.length > 0) {
              pluginSuccessCountShared.value += 1;
              runInferenceOnJS(
                rawOutput,
                frame.width,
                frame.height,
                resizedWidth,
                resizedHeight,
                padX,
                padY,
                scale,
                true,
                true
              );
              return;
            }
            // Empty array from native path means "no detections", not plugin failure.
            pluginEmptyCountShared.value += 1;
            publishNoDetectionsOnJS(frame.width, frame.height);
            isInferencingShared.value = false;
            inferenceStartedAt.value = 0;
            return;
          }
          // Null/undefined means plugin failed to produce output.
          fallbackCountShared.value += 1;
          // Fall through to resize + bridge inference path.
        } else {
          fallbackCountShared.value += 1;
        }

        const rgbData = resizePlugin.resize(frame, {
          scale: { width: resizedWidth, height: resizedHeight },
          pixelFormat: 'rgb',
          dataType: 'uint8',
        });
        if (!rgbData || rgbData.length === 0) {
          isInferencingShared.value = false;
          inferenceStartedAt.value = 0;
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
          false,
          true
        );
      }
    }
  }, [runInferenceOnJS, runYOLOFromFramePlugin, reportInferencePathStatsOnJS, publishNoDetectionsOnJS]);

  const handleExportPidCsv = async () => {
    try {
      const isSharingAvailable = await Sharing.isAvailableAsync();
      if (!isSharingAvailable) {
        Alert.alert('Export unavailable', 'Share sheet is not available on this device.');
        return;
      }
      const csvUri = await preparePidTelemetryCsvForExport();
      await Sharing.shareAsync(csvUri, {
        mimeType: 'text/csv',
        dialogTitle: 'Export PID telemetry CSV',
        UTI: 'public.comma-separated-values-text',
      });
    } catch (error) {
      // console.error('❌ Failed to export PID CSV:', error);
      void error;
      Alert.alert('Export failed', 'Could not export PID telemetry CSV.');
    }
  };


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
      {!isStreamMode && (
        <>
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
          <ThemedText style={styles.toggleLabel}>Live Inference (5 FPS)</ThemedText>
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
            // Trigger single-shot frame processor inference only
            singleShotRequestId.value += 1;
          }}
          pointerEvents="auto"
        >
          <ThemedText style={styles.buttonText}>
            {isSnapshotting ? 'Saving…' : isInferencing ? 'Running…' : 'Snap Inference'}
          </ThemedText>
        </Pressable>
        <Pressable
          style={styles.button}
          onPress={handleExportPidCsv}
          pointerEvents="auto"
        >
          <ThemedText style={styles.buttonText}>Export PID CSV</ThemedText>
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
        </>
      )}
      {isStreamMode && (
        <>
          <Pressable style={styles.backButton} onPress={() => router.back()} pointerEvents="auto">
            <ThemedText style={styles.backButtonText}>← Back</ThemedText>
          </Pressable>
          <View style={styles.streamBadge} pointerEvents="none">
            <View style={styles.streamDot} />
            <ThemedText style={styles.streamBadgeText}>Streaming</ThemedText>
          </View>
        </>
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
  streamBadge: {
    position: 'absolute',
    top: 44,
    right: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  streamDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#22c55e',
  },
  streamBadgeText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '600',
  },
});
