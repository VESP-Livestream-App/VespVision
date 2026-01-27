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
  classId: number;
};

const MODEL_INPUT_WIDTH = 640;
const MODEL_INPUT_HEIGHT = 640;
const BOX_EPS = 1e-4;
const FILTER_CLASS_ID = 32;

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
  const rows = 300;
  const cols = 6;
  if (raw.length !== rows * cols) {
    return [];
  }

  const detections: Detection[] = [];
  for (let r = 0; r < rows; r += 1) {
    const offset = r * cols;
    const rawX1 = raw[offset];
    const rawY1 = raw[offset + 1];
    const rawX2 = raw[offset + 2];
    const rawY2 = raw[offset + 3];
    const rawClass = raw[offset + 5];

    const x1 = Math.min(1, Math.max(0, rawX1));
    const y1 = Math.min(1, Math.max(0, rawY1));
    const x2 = Math.min(1, Math.max(0, rawX2));
    const y2 = Math.min(1, Math.max(0, rawY2));

    const w = x2 - x1;
    const h = y2 - y1;
    if (w <= BOX_EPS || h <= BOX_EPS) {
      continue;
    }
    const classId = Math.round(rawClass);
    if (classId !== FILTER_CLASS_ID) {
      continue;
    }

    detections.push({
      x: x1 * frameWidth,
      y: y1 * frameHeight,
      width: w * frameWidth,
      height: h * frameHeight,
      score: 1,
      classId,
    });
  }

  return detections;
};

const analyzeOutput300x6 = (raw: Float32Array) => {
  'worklet';
  const rows = 300;
  const cols = 6;
  if (raw.length !== rows * cols) {
    return null;
  }

  let globalMin = Infinity;
  let globalMax = -Infinity;
  const colMin = new Array<number>(cols).fill(Infinity);
  const colMax = new Array<number>(cols).fill(-Infinity);
  const colMaxRow = new Array<number>(cols).fill(-1);
  const colMaxRowValues = new Array<number>(cols * cols).fill(0);

  for (let r = 0; r < rows; r += 1) {
    const base = r * cols;
    for (let c = 0; c < cols; c += 1) {
      const value = raw[base + c];
      if (value < globalMin) {
        globalMin = value;
      }
      if (value > globalMax) {
        globalMax = value;
      }
      if (value < colMin[c]) {
        colMin[c] = value;
      }
      if (value > colMax[c]) {
        colMax[c] = value;
        colMaxRow[c] = r;
        for (let i = 0; i < cols; i += 1) {
          colMaxRowValues[c * cols + i] = raw[base + i];
        }
      }
    }
  }

  return {
    globalMin,
    globalMax,
    colMin,
    colMax,
    colMaxRow,
    colMaxRowValues,
  };
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
  const debugCounter = React.useMemo(() => Worklets.createSharedValue(0), []);
  const reportDetections = React.useMemo(
    () =>
      Worklets.createRunOnJS((nextDetections: Detection[]) => {
        setDetections(nextDetections);
      }),
    []
  );
  const reportDetectionsLog = React.useMemo(
    () =>
      Worklets.createRunOnJS(
        (
          total: number,
          containsClass32: boolean,
          topAreas: number[],
          topClassIds: number[],
          topBoxes: number[]
        ) => {
          const formatted = topAreas.map((area, index) => ({
            classId: topClassIds[index],
            area: Number(area.toFixed(4)),
            box: topBoxes.slice(index * 4, index * 4 + 4),
          }));
          console.log(
            `Detections: total=${total} containsClass32=${containsClass32} topCandidates=${JSON.stringify(formatted)}`
          );
        }
      ),
    []
  );
  const reportDebug = React.useMemo(
    () =>
      Worklets.createRunOnJS(
        (
          count: number,
          outputLength: number,
          globalMin: number,
          globalMax: number,
          colMin: number[],
          colMax: number[],
          colMaxRow: number[],
          colMaxRowValues: number[]
        ) => {
          console.log(
            `Detection debug: count=${count} outputLength=${outputLength} globalMin=${globalMin.toFixed(3)} globalMax=${globalMax.toFixed(3)}`
          );
          const cols = colMin.length;
          for (let c = 0; c < cols; c += 1) {
            const row = colMaxRow[c];
            const rowValues = colMaxRowValues.slice(c * cols, c * cols + cols);
            const maxValue = colMax[c];
            const minValue = colMin[c];
            const needsSigmoid = minValue < 0 || maxValue > 1;
            const sigmoidMax = needsSigmoid ? 1 / (1 + Math.exp(-maxValue)) : null;
            console.log(
              `col${c}: min=${minValue.toFixed(3)} max=${maxValue.toFixed(3)} maxRow=${row} maxRowValues=${JSON.stringify(
                rowValues
              )}${sigmoidMax === null ? '' : ` sigmoid(max)=${sigmoidMax.toFixed(3)}`}`
            );
          }
        }
      ),
    []
  );
  const reportIo = React.useMemo(
    () =>
      Worklets.createRunOnJS(
        (
          inputLength: number,
          inputPreview: number[],
          outputCount: number,
          outputLengths: number[],
          outputPreview: number[]
        ) => {
          console.log(
            `TFLite IO: inputLength=${inputLength} inputPreview=${JSON.stringify(inputPreview)} outputCount=${outputCount} outputLengths=${JSON.stringify(
              outputLengths
            )} outputPreview=${JSON.stringify(outputPreview)}`
          );
        }
      ),
    []
  );
  useEffect(() => {
    if (!model) {
      return;
    }
    const inputs = model.inputs.map((tensor) => ({
      name: tensor.name,
      dataType: tensor.dataType,
      shape: tensor.shape,
    }));
    const outputs = model.outputs.map((tensor) => ({
      name: tensor.name,
      dataType: tensor.dataType,
      shape: tensor.shape,
    }));
    console.log('Model tensors:', { inputs, outputs });
  }, [model]);

  const lastLogMs = React.useMemo(() => Worklets.createSharedValue(0), []);
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
      debugCounter.value += 1;
      if (debugCounter.value % 60 === 0) {
        const inputPreview = Array.from(resized.slice(0, 6));
        const outputs = Array.isArray(output) ? output : [output];
        const outputCount = outputs.length;
        const outputLengths = outputs.map((item) =>
          item instanceof Float32Array || item instanceof Uint8Array ? item.length : 0
        );
        const outputPreview =
          outputs[0] instanceof Float32Array || outputs[0] instanceof Uint8Array
            ? Array.from(outputs[0].slice(0, 6))
            : [];
        reportIo(resized.length, inputPreview, outputCount, outputLengths, outputPreview);
      }
      const primary = Array.isArray(output) ? output[0] : output;
      const data = toFloat32Array(primary);
      if (!data) {
        return;
      }

      const nextDetections = parseYoloOutput(data, frame.width, frame.height);
      reportDetections(nextDetections);

      if (data.length === 1800) {
        if (debugCounter.value % 60 === 0) {
          const stats = analyzeOutput300x6(data);
          if (stats) {
            reportDebug(
              nextDetections.length,
              data.length,
              stats.globalMin,
              stats.globalMax,
              stats.colMin,
              stats.colMax,
              stats.colMaxRow,
              stats.colMaxRowValues
            );
          }
        }
      }

      const nowMs = frame.timestamp / 1000000;
      if (nowMs - lastLogMs.value >= 500) {
        lastLogMs.value = nowMs;
        const topK = 5;
        const topAreas = new Array<number>(topK).fill(0);
        const topClassIds = new Array<number>(topK).fill(-1);
        const topBoxes = new Array<number>(topK * 4).fill(0);
        let containsClass32 = false;

        if (data.length === 1800) {
          for (let r = 0; r < 300; r += 1) {
            const offset = r * 6;
            const rawX1 = data[offset];
            const rawY1 = data[offset + 1];
            const rawX2 = data[offset + 2];
            const rawY2 = data[offset + 3];
            const classId = Math.round(data[offset + 5]);

            if (classId === FILTER_CLASS_ID) {
              containsClass32 = true;
            }

            const x1 = Math.min(1, Math.max(0, rawX1));
            const y1 = Math.min(1, Math.max(0, rawY1));
            const x2 = Math.min(1, Math.max(0, rawX2));
            const y2 = Math.min(1, Math.max(0, rawY2));
            const w = x2 - x1;
            const h = y2 - y1;
            if (w <= BOX_EPS || h <= BOX_EPS) {
              continue;
            }

            const area = w * h;
            let insertIndex = -1;
            for (let i = 0; i < topK; i += 1) {
              if (area > topAreas[i]) {
                insertIndex = i;
                break;
              }
            }
            if (insertIndex === -1) {
              continue;
            }

            for (let i = topK - 1; i > insertIndex; i -= 1) {
              topAreas[i] = topAreas[i - 1];
              topClassIds[i] = topClassIds[i - 1];
              const src = (i - 1) * 4;
              const dst = i * 4;
              topBoxes[dst] = topBoxes[src];
              topBoxes[dst + 1] = topBoxes[src + 1];
              topBoxes[dst + 2] = topBoxes[src + 2];
              topBoxes[dst + 3] = topBoxes[src + 3];
            }

            topAreas[insertIndex] = area;
            topClassIds[insertIndex] = classId;
            const base = insertIndex * 4;
            topBoxes[base] = x1;
            topBoxes[base + 1] = y1;
            topBoxes[base + 2] = x2;
            topBoxes[base + 3] = y2;
          }
        }

        reportDetectionsLog(nextDetections.length, containsClass32, topAreas, topClassIds, topBoxes);
      }
    },
    [model, resize, reportDetections, debugCounter, reportDebug, lastLogMs, reportDetectionsLog]
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
        <ThemedText style={styles.subtitle}>
          {`Sports ball detections: ${detections.length}`}
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
