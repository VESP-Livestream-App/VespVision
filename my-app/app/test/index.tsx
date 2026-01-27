import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, ActivityIndicator, Pressable, Image, ScrollView } from 'react-native';
import { Asset } from 'expo-asset';
import * as ImageManipulator from 'expo-image-manipulator';
import { ThemedView } from '@/components/themed-view';
import { ThemedText } from '@/components/themed-text';
import { runYoloInference } from '@/modules/yoloInference';
import { loadYoloModel, closeYoloModel } from '@/modules/yoloModel';
import type { Detection } from '@/modules/yoloUtils';

const TEST_IMAGES = [
  { id: 'test.jpg', label: 'test.jpg', source: require('../../assets/test.jpg') },
  { id: 'test2.jpg', label: 'test2.jpg', source: require('../../assets/test2.jpg') },
  { id: 'test3.jpg', label: 'test3.jpg', source: require('../../assets/test3.jpg') },
  { id: 'test4.jpg', label: 'test4.jpg', source: require('../../assets/test4.jpg') },
];

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

export default function TestImageScreen() {
  const [isRunning, setIsRunning] = useState(false);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [isModelLoaded, setIsModelLoaded] = useState(false);
  const [selectedImageId, setSelectedImageId] = useState(TEST_IMAGES[0].id);
  const [normalizeInput, setNormalizeInput] = useState(true);
  const [rgbOrder, setRgbOrder] = useState(true);
  const [applySigmoid, setApplySigmoid] = useState(false);
  const [boxIsNormalized, setBoxIsNormalized] = useState(true);

  const selectedImage = useMemo(
    () => TEST_IMAGES.find((img) => img.id === selectedImageId) ?? TEST_IMAGES[0],
    [selectedImageId]
  );
  const asset = useMemo(() => Asset.fromModule(selectedImage.source), [selectedImage]);

  useEffect(() => {
    let isMounted = true;
    const loadModel = async () => {
      const loaded = await loadYoloModel();
      if (isMounted) {
        setIsModelLoaded(loaded);
      }
    };
    loadModel();
    return () => {
      isMounted = false;
      if (isModelLoaded) {
        closeYoloModel();
      }
    };
  }, []);

  const runTestInference = async () => {
    if (isRunning || !isModelLoaded) {
      return;
    }
    setIsRunning(true);
    try {
      await asset.downloadAsync();
      const uri = asset.localUri ?? asset.uri;
      const resized = await ImageManipulator.manipulateAsync(
        uri,
        [{ resize: { width: 640, height: 640 } }],
        { format: ImageManipulator.SaveFormat.JPEG, compress: 0.9, base64: true }
      );
      if (!resized.base64) {
        throw new Error('Failed to read resized image as base64');
      }
      setPreviewUri(resized.uri);
      const rgbData = decodeJpegToRgb(resized.base64);
      const results = await runYoloInference(rgbData, 640, 640, {
        normalize: normalizeInput,
        rgbOrder,
        applySigmoid,
        boxIsNormalized,
      });
      setDetections(results);
      setLastRunAt(Date.now());
      console.log('🧪 Test image detections:', results);
    } catch (error) {
      console.error('Test inference failed:', error);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <ThemedView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
      <ThemedText style={styles.title}>Test Image Inference</ThemedText>
      <ThemedText style={styles.subtitle}>Runs YOLO on a bundled test image</ThemedText>
      <Image source={selectedImage.source} style={styles.image} resizeMode="contain" />
      <View style={styles.imageSelector}>
        {TEST_IMAGES.map((img) => (
          <Pressable
            key={img.id}
            style={[styles.selectorButton, selectedImageId === img.id && styles.selectorButtonActive]}
            onPress={() => setSelectedImageId(img.id)}
          >
            <ThemedText style={styles.selectorText}>{img.label}</ThemedText>
          </Pressable>
        ))}
      </View>
      <View style={styles.toggles}>
        <Pressable style={styles.toggleButton} onPress={() => setNormalizeInput((v) => !v)}>
          <ThemedText style={styles.toggleText}>Normalize: {normalizeInput ? 'On' : 'Off'}</ThemedText>
        </Pressable>
        <Pressable style={styles.toggleButton} onPress={() => setRgbOrder((v) => !v)}>
          <ThemedText style={styles.toggleText}>RGB: {rgbOrder ? 'RGB' : 'BGR'}</ThemedText>
        </Pressable>
        <Pressable style={styles.toggleButton} onPress={() => setApplySigmoid((v) => !v)}>
          <ThemedText style={styles.toggleText}>Sigmoid: {applySigmoid ? 'On' : 'Off'}</ThemedText>
        </Pressable>
        <Pressable style={styles.toggleButton} onPress={() => setBoxIsNormalized((v) => !v)}>
          <ThemedText style={styles.toggleText}>Box Norm: {boxIsNormalized ? 'On' : 'Off'}</ThemedText>
        </Pressable>
      </View>
      <Pressable style={styles.button} onPress={runTestInference}>
        <ThemedText style={styles.buttonText}>
          {isRunning ? 'Running…' : `Run on ${selectedImage.label}`}
        </ThemedText>
      </Pressable>
      <ThemedText style={styles.debugText}>
        Model: {isModelLoaded ? 'Loaded ✓' : 'Loading…'}
      </ThemedText>
      {isRunning && <ActivityIndicator style={styles.loader} />}
      <ThemedText style={styles.debugText}>
        Last run: {lastRunAt ? new Date(lastRunAt).toLocaleTimeString() : '—'}
      </ThemedText>
      <ThemedText style={styles.debugText}>
        Detections: {detections.length}
      </ThemedText>
      {previewUri && (
        <View style={styles.previewContainer}>
          <ThemedText style={styles.previewLabel}>Resized 640×640 Preview</ThemedText>
          <View style={styles.previewWrapper}>
            <Image source={{ uri: previewUri }} style={styles.previewImage} />
            <View style={styles.previewOverlay} pointerEvents="none">
              {detections.slice(0, 10).map((det, idx) => {
                const scale = 160 / 640;
                const left = Math.max(0, det.x * scale);
                const top = Math.max(0, det.y * scale);
                const width = Math.max(1, det.width * scale);
                const height = Math.max(1, det.height * scale);
                return (
                  <View
                    key={`${det.class}-${idx}`}
                    style={[styles.box, { left, top, width, height }]}
                  >
                    <ThemedText style={styles.boxLabel}>
                      {det.className ?? det.class} {(det.confidence * 100).toFixed(0)}%
                    </ThemedText>
                  </View>
                );
              })}
            </View>
          </View>
        </View>
      )}
      <View style={styles.results}>
        {detections.slice(0, 20).map((det, idx) => (
          <ThemedText key={`${det.class}-${idx}`} style={styles.resultItem}>
            {det.className ?? det.class} {(det.confidence * 100).toFixed(1)}%
          </ThemedText>
        ))}
      </View>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
    paddingTop: 60,
    paddingBottom: 40,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 14,
    marginBottom: 12,
  },
  image: {
    width: '100%',
    height: 220,
    backgroundColor: 'rgba(0,0,0,0.05)',
    borderRadius: 8,
  },
  imageSelector: {
    marginTop: 10,
    flexDirection: 'row',
    gap: 8,
  },
  selectorButton: {
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  selectorButtonActive: {
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
  },
  selectorText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
  toggles: {
    marginTop: 12,
    gap: 8,
  },
  toggleButton: {
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  toggleText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '600',
  },
  button: {
    marginTop: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
  loader: {
    marginTop: 10,
  },
  debugText: {
    fontSize: 12,
    marginTop: 6,
  },
  previewContainer: {
    marginTop: 12,
    alignItems: 'center',
  },
  previewLabel: {
    fontSize: 12,
    marginBottom: 6,
  },
  previewWrapper: {
    width: 160,
    height: 160,
  },
  previewImage: {
    width: 160,
    height: 160,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.2)',
  },
  previewOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  box: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: 'rgba(0, 255, 0, 0.9)',
    backgroundColor: 'rgba(0, 0, 0, 0.1)',
  },
  boxLabel: {
    color: 'white',
    fontSize: 9,
    paddingHorizontal: 2,
    paddingVertical: 1,
    backgroundColor: 'rgba(0, 128, 0, 0.7)',
  },
  results: {
    marginTop: 12,
  },
  resultItem: {
    fontSize: 13,
    marginBottom: 4,
  },
});
