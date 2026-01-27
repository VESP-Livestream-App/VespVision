import React, { useEffect, useState, useRef, useMemo } from 'react';
import { StyleSheet, View, ActivityIndicator, AppState, Pressable } from 'react-native';
import { 
  Camera, 
  useCameraDevice, 
  useCameraPermission,
  useFrameProcessor,
  Frame,
} from 'react-native-vision-camera';
import { createResizePlugin } from 'vision-camera-resize-plugin';
import { useFocusEffect } from '@react-navigation/native';
import { ThemedView } from '@/components/themed-view';
import { ThemedText } from '@/components/themed-text';
import { loadYoloModel, closeYoloModel } from '@/modules/yoloModel';
import { runYoloInference } from '@/modules/yoloInference';
import type { Detection } from '@/modules/yoloUtils';
import { useRunOnJS, useSharedValue } from 'react-native-worklets-core';

export default function CameraScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  const [isActive, setIsActive] = useState(true);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [isModelLoaded, setIsModelLoaded] = useState(false);
  const [isInferencing, setIsInferencing] = useState(false);
  const [lastInferenceAt, setLastInferenceAt] = useState<number | null>(null);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
  const [lastFrameSize, setLastFrameSize] = useState({ width: 0, height: 0 });
  const singleShotRequestId = useSharedValue(0);
  const lastProcessedRequestId = useSharedValue(0);

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

  // Load TFLite model on mount
  useEffect(() => {
    const loadModel = async () => {
      const loaded = await loadYoloModel();
      setIsModelLoaded(loaded);
    };

    loadModel();

    return () => {
      // Clean up model when component unmounts
      if (isModelLoaded) {
        closeYoloModel();
      }
    };
  }, []);

  const handleInferenceOnJS = async (rgbData: Uint8Array, frameWidth: number, frameHeight: number) => {
    if (!isModelLoaded || isInferencing) {
      return;
    }
    setIsInferencing(true);
    try {
      const detections = await runYoloInference(rgbData, frameWidth, frameHeight);
      setDetections(detections);
      setLastFrameSize({ width: frameWidth, height: frameHeight });
      setLastInferenceAt(Date.now());
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
    } finally {
      setIsInferencing(false);
    }
  };

  const runInferenceOnJS = useRunOnJS(handleInferenceOnJS, [isModelLoaded, isInferencing]);

  const resizePlugin = useMemo(() => createResizePlugin(), []);

  const frameProcessor = useFrameProcessor((frame: Frame) => {
    'worklet';
    if (!isModelLoaded) {
      return;
    }
    if (singleShotRequestId.value === lastProcessedRequestId.value) {
      return;
    }
    lastProcessedRequestId.value = singleShotRequestId.value;

    const rgbData = resizePlugin.resize(frame, {
      scale: { width: 640, height: 640 },
      pixelFormat: 'rgb',
      dataType: 'uint8',
    });

    runInferenceOnJS(rgbData, frame.width, frame.height);
  }, [isModelLoaded, singleShotRequestId, lastProcessedRequestId, runInferenceOnJS]);


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
        isActive={isActive}
        frameProcessor={frameProcessor}
        enableFpsGraph={true}
        pixelFormat="yuv"
      />
      <View style={styles.overlay}>
        <ThemedText style={styles.title}>YOLO11n Object Detection</ThemedText>
        {isModelLoaded && (
          <ThemedText style={styles.modelStatus}>Model Loaded ✓</ThemedText>
        )}
        <Pressable
          style={styles.button}
          onPress={() => {
            if (!isModelLoaded || isInferencing) {
              return;
            }
            singleShotRequestId.value += 1;
          }}
        >
          <ThemedText style={styles.buttonText}>
            {isInferencing ? 'Running…' : 'Snap Inference'}
          </ThemedText>
        </Pressable>
        <ThemedText style={styles.debugText}>
          Last inference: {lastInferenceAt ? new Date(lastInferenceAt).toLocaleTimeString() : '—'}
        </ThemedText>
        <ThemedText style={styles.debugText}>
          Detections: {detections.length}
        </ThemedText>
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
});

