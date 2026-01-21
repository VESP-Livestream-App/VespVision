import React, { useEffect, useState } from 'react';
import { StyleSheet, View, ActivityIndicator, AppState } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission, useFrameProcessor } from 'react-native-vision-camera';
import { useFocusEffect } from '@react-navigation/native';
import { Worklets } from 'react-native-worklets-core';
import { useResizePlugin } from 'vision-camera-resize-plugin';
import { useTensorflowModel } from 'react-native-fast-tflite';
import { ThemedView } from '@/components/themed-view';
import { ThemedText } from '@/components/themed-text';

type Detection = {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
};

const MODEL_INPUT_WIDTH = 640;
const MODEL_INPUT_HEIGHT = 640;
const SCORE_THRESHOLD = 0.4;
const SPORTS_BALL_CLASS_ID = 32;
const YOLO_OUTPUT_STRIDE = 85;

const toFloat32Array = (output: unknown): Float32Array | null => {
  'worklet';
  if (output instanceof Float32Array) {
    return output;
  }
  if (output && typeof output === 'object' && 'data' in output) {
    const data = (output as { data?: unknown }).data;
    if (data instanceof Float32Array) {
      return data;
    }
  }
  return null;
};

const parseYoloOutput = (
  raw: Float32Array,
  frameWidth: number,
  frameHeight: number
): Detection[] => {
  'worklet';
  if (raw.length % YOLO_OUTPUT_STRIDE !== 0) {
    return [];
  }

  const detections: Detection[] = [];
  const candidates = raw.length / YOLO_OUTPUT_STRIDE;
  const scaleX = frameWidth / MODEL_INPUT_WIDTH;
  const scaleY = frameHeight / MODEL_INPUT_HEIGHT;

  for (let i = 0; i < candidates; i += 1) {
    const offset = i * YOLO_OUTPUT_STRIDE;
    const cx = raw[offset];
    const cy = raw[offset + 1];
    const w = raw[offset + 2];
    const h = raw[offset + 3];
    const objectness = raw[offset + 4];

    let bestClassScore = 0;
    let bestClassId = -1;
    for (let c = 5; c < YOLO_OUTPUT_STRIDE; c += 1) {
      const classScore = raw[offset + c];
      if (classScore > bestClassScore) {
        bestClassScore = classScore;
        bestClassId = c - 5;
      }
    }

    const score = objectness * bestClassScore;
    if (bestClassId !== SPORTS_BALL_CLASS_ID || score < SCORE_THRESHOLD) {
      continue;
    }

    const x = (cx - w / 2) * scaleX;
    const y = (cy - h / 2) * scaleY;
    detections.push({
      x,
      y,
      width: w * scaleX,
      height: h * scaleY,
      score,
    });
  }

  return detections;
};

export default function CameraScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  const [isActive, setIsActive] = useState(true);
  const [detections, setDetections] = useState<Detection[]>([]);
  const modelState = useTensorflowModel(
    require('../yolo11n_float32.tflite')
  );
  const model = modelState.state === 'loaded' ? modelState.model : undefined;
  const { resize } = useResizePlugin();
  const reportDetections = React.useMemo(
    () =>
      Worklets.createRunOnJS((nextDetections: Detection[]) => {
        setDetections(nextDetections);
        if (nextDetections.length > 0) {
          console.log('Sports ball detections:', nextDetections);
        }
      }),
    []
  );

  const frameProcessor = useFrameProcessor(
    (frame) => {
      'worklet';
      if (!model) {
        return;
      }

      const resized = resize(frame, {
        scale: {
          width: MODEL_INPUT_WIDTH,
          height: MODEL_INPUT_HEIGHT,
        },
        pixelFormat: 'rgb',
        dataType: 'float32',
      });

      const output = model.runSync([resized]);
      const primary = Array.isArray(output) ? output[0] : output;
      const data = toFloat32Array(primary);
      if (!data) {
        return;
      }

      const nextDetections = parseYoloOutput(data, frame.width, frame.height);
      reportDetections(nextDetections);
    },
    [model, resize, reportDetections]
  );

  useEffect(() => {
    if (!hasPermission) {
      requestPermission();
    }
  }, [hasPermission, requestPermission]);

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
    <View style={styles.container}>
      <Camera
        style={styles.camera}
        device={device}
        isActive={isActive}
        frameProcessor={frameProcessor}
      />
      <View style={styles.overlay}>
        <ThemedText style={styles.title}>Camera View</ThemedText>
        {detections.length > 0 ? (
          <ThemedText style={styles.subtitle}>
            {`Sports balls: ${detections.length}`}
          </ThemedText>
        ) : null}
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
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: 'white',
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: -1, height: 1 },
    textShadowRadius: 10,
  },
  subtitle: {
    marginTop: 8,
    fontSize: 16,
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
});
