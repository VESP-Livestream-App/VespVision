import React, { useEffect, useState, useCallback } from 'react';
import { StyleSheet, View, ActivityIndicator, AppState } from 'react-native';
import { 
  Camera, 
  useCameraDevice, 
  useCameraPermission, 
  useFrameProcessor,
  runAtTargetFps 
} from 'react-native-vision-camera';
import { useTensorflowModel } from 'react-native-fast-tflite';
import { useResizePlugin } from 'vision-camera-resize-plugin';
import { runOnJS } from 'react-native-reanimated';
import { useFocusEffect } from '@react-navigation/native';
import { ThemedView } from '@/components/themed-view';
import { ThemedText } from '@/components/themed-text';

//npm install react-native-fast-tflite vision-camera-resize-plugin react-native-worklets-core react-native-reanimated

// --- Configuration Constants ---
// UPDATED PATH: 
// '../../' goes up out of 'screens' and 'apps', then down into 'assets'
const MODEL_FILE = require('camera.tsx/(tabs)/assets\images/yolo11n.tflite'); 

const INPUT_SIZE = 640; 
const CONFIDENCE_THRESHOLD = 0.5; 
const TARGET_CLASS_ID = 0; 

// --- WORKLET: Helper to Calculate Center ---
function calculateObjectCenter(outputTensor: any, frameWidth: number, frameHeight: number) {
  'worklet';
  
  const data = outputTensor[0];
  if (!data) return null;

  let maxScore = 0;
  let bestDetection = null;

  // Assuming [1, 84, 8400] output layout
  const numDetections = 8400; 
  
  for (let i = 0; i < numDetections; i++) {
    const scoreIndex = (4 + TARGET_CLASS_ID) * numDetections + i;
    const score = data[scoreIndex];

    if (score > maxScore && score > CONFIDENCE_THRESHOLD) {
      maxScore = score;
      const xIndex = 0 * numDetections + i;
      const yIndex = 1 * numDetections + i;
      
      bestDetection = {
        x: data[xIndex],
        y: data[yIndex],
        score: score
      };
    }
  }

  if (bestDetection) {
    const scaleX = frameWidth / INPUT_SIZE;
    const scaleY = frameHeight / INPUT_SIZE;

    return {
      x: bestDetection.x * scaleX,
      y: bestDetection.y * scaleY,
      confidence: bestDetection.score
    };
  }

  return null;
}

export default function CameraScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  const [isActive, setIsActive] = useState(true);
  
  // State to hold tracking data including confidence
  const [targetCoords, setTargetCoords] = useState<{x: number, y: number, confidence: number} | null>(null);

  // 1. Load Model & Plugin
  const plugin = useTensorflowModel(MODEL_FILE);
  const { resize } = useResizePlugin();

  useEffect(() => {
    if (!hasPermission) {
      requestPermission();
    }
  }, [hasPermission, requestPermission]);

  useFocusEffect(
    React.useCallback(() => {
      setIsActive(true);
      return () => setIsActive(false);
    }, [])
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') {
        setIsActive(true);
      } else {
        setIsActive(false);
      }
    });
    return () => subscription.remove();
  }, []);

  // 2. Handler for Main Thread
  const handleDetection = useCallback((center: {x: number, y: number, confidence: number}) => {
    setTargetCoords(center);
  }, []);

  // 3. Frame Processor
  const frameProcessor = useFrameProcessor((frame) => {
    'worklet';
    if (plugin.state !== 'loaded' || plugin.model == null) return;

    runAtTargetFps(5, () => {
      'worklet';
      const resized = resize(frame, {
        scale: { width: INPUT_SIZE, height: INPUT_SIZE },
        pixelFormat: 'rgb',
        dataType: 'float32',
      });

      const outputs = plugin.model.runSync([resized]);
      const center = calculateObjectCenter(outputs, frame.width, frame.height);

      if (center) {
        runOnJS(handleDetection)(center);
      }
    });
  }, [plugin, resize]);

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
      
      {/* Visual Marker */}
      {targetCoords && (
        <View style={[styles.targetBox, { 
            left: targetCoords.x - 10, 
            top: targetCoords.y - 10 
        }]} />
      )}

      {/* Debug Info Overlay */}
      <View style={styles.overlay}>
        <ThemedText style={styles.title}>Camera View</ThemedText>
        
        {plugin.state !== 'loaded' ? (
           <ThemedText style={styles.message}>Loading Model...</ThemedText>
        ) : (
           <View style={styles.debugContainer}>
             <ThemedText style={styles.debugText}>
               Model Loaded
             </ThemedText>
             {targetCoords ? (
               <>
                 <ThemedText style={styles.debugText}>X: {targetCoords.x.toFixed(0)} | Y: {targetCoords.y.toFixed(0)}</ThemedText>
                 <ThemedText style={styles.debugText}>Conf: {(targetCoords.confidence * 100).toFixed(1)}%</ThemedText>
               </>
             ) : (
               <ThemedText style={styles.debugText}>Searching...</ThemedText>
             )}
           </View>
        )}
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
    backgroundColor: 'rgba(0,0,0,0.3)'
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
    color: 'white'
  },
  loader: {
    marginTop: 20,
  },
  targetBox: {
    position: 'absolute',
    width: 20,
    height: 20,
    backgroundColor: 'red',
    borderRadius: 10,
    borderWidth: 2,
    borderColor: 'white'
  },
  debugContainer: {
    marginTop: 10,
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 10,
    borderRadius: 8
  },
  debugText: {
    color: '#00ff00',
    fontSize: 16,
    fontWeight: 'bold',
    fontFamily: 'monospace'
  }
});