import { startTimer, withProfiling } from '@/lib/profiler';
import { TFLite, isTFLiteAvailable } from '@/modules/TFLiteModule';
import { getYOLOInputShape, getYOLOInputSize, parseYOLOOutput, type Detection } from '@/modules/yoloUtils';

type PreprocessOptions = {
  normalize?: boolean;
  rgbOrder?: boolean;
  applySigmoid?: boolean;
  boxIsNormalized?: boolean;
};

let hasLoggedInputStats = false;
let hasLoggedLayoutStats = false;
let hasLoggedOutputStats = false;

type OutputLayout = 'predMajor' | 'classMajor';

const preprocessRgb = withProfiling('preprocessRgb', (rgbData: ArrayLike<number>, options: PreprocessOptions): number[] => {
  // Optimized: Remove min/max tracking (saves ~100ms)
  const normalize = options.normalize ?? true;
  const rgbOrder = options.rgbOrder ?? true;
  const out: number[] = new Array(rgbData.length);
  const inv255 = 1.0 / 255.0; // Pre-calculate division

  // Optimized loop: single pass, no conditionals in hot path
  if (normalize && rgbOrder) {
    // Fast path: normalize + RGB order (most common)
    for (let i = 0; i < rgbData.length; i += 3) {
      out[i] = rgbData[i] * inv255;
      out[i + 1] = rgbData[i + 1] * inv255;
      out[i + 2] = rgbData[i + 2] * inv255;
    }
  } else if (normalize) {
    // Normalize + BGR order
    for (let i = 0; i < rgbData.length; i += 3) {
      out[i] = rgbData[i + 2] * inv255;     // B->R
      out[i + 1] = rgbData[i + 1] * inv255; // G->G
      out[i + 2] = rgbData[i] * inv255;     // R->B
    }
  } else if (rgbOrder) {
    // No normalize + RGB order
    for (let i = 0; i < rgbData.length; i += 3) {
      out[i] = rgbData[i];
      out[i + 1] = rgbData[i + 1];
      out[i + 2] = rgbData[i + 2];
    }
  } else {
    // No normalize + BGR order
    for (let i = 0; i < rgbData.length; i += 3) {
      out[i] = rgbData[i + 2];
      out[i + 1] = rgbData[i + 1];
      out[i + 2] = rgbData[i];
    }
  }

  if (!hasLoggedInputStats) {
    hasLoggedInputStats = true;
    console.log('🔎 YOLO input stats', {
      normalize,
      rgbOrder,
      firstPixel: [rgbData[0], rgbData[1], rgbData[2]],
      optimized: true,
    });
  }

  return out;
});

export const runYoloInference = async (
  rgbData: ArrayLike<number>,
  frameWidth: number,
  frameHeight: number,
  options: PreprocessOptions = {}
): Promise<Detection[]> => {
  if (!isTFLiteAvailable() || !TFLite) {
    console.warn('TFLite module is not available for inference');
    return [];
  }

  // Normalize input data to [0, 1] range and optionally swap channels
  const normalizedInput = preprocessRgb(rgbData, options);

  // YOLO input shape [1, 640, 640, 3]
  const inputShape = getYOLOInputShape();
  
  // Track native inference time
  const nativeInferenceStart = Date.now();
  const endInferenceTimer = startTimer('TFLite.runInference');
  const output = await TFLite.runInference(normalizedInput, inputShape);
  endInferenceTimer();
  const nativeInferenceTime = Date.now() - nativeInferenceStart;
  
  // Log native inference timing
  console.log(`🔥 [Native Inference]`, {
    time: `${nativeInferenceTime}ms`,
    inputSize: normalizedInput.length,
  });
  
  if (!output) {
    console.warn('TFLite returned no output');
    return [];
  }

  const normalizedOutput = normalizeOutputLayout(output);
  logOutputStats(normalizedOutput);
  return parseYOLOOutput(normalizedOutput, frameWidth, frameHeight, {
    inputSize: getYOLOInputSize(), // Use configurable input size
    numClasses: 2, // basketball and rim
    confidenceThreshold: 0.25,
    nmsThreshold: 0.4,
    applySigmoid: options.applySigmoid ?? false,
    boxIsNormalized: options.boxIsNormalized ?? true,
  });
};

const normalizeOutputLayout = (output: number[]): number[] => {
  const numPredictions = 8400;
  if (output.length % numPredictions !== 0) {
    return output;
  }
  const numValues = output.length / numPredictions;
  if (numValues !== 84 && numValues !== 85) {
    return output;
  }

  const layout = detectLayout(output, numPredictions, numValues);
  if (!hasLoggedLayoutStats) {
    hasLoggedLayoutStats = true;
    console.log('🔎 YOLO output layout', { layout, numPredictions, numValues });
  }

  if (layout === 'predMajor') {
    return output;
  }

  // Transpose from [numValues, numPredictions] to [numPredictions, numValues]
  const transposed = new Array(output.length);
  for (let v = 0; v < numValues; v++) {
    const rowOffset = v * numPredictions;
    for (let p = 0; p < numPredictions; p++) {
      transposed[p * numValues + v] = output[rowOffset + p];
    }
  }
  return transposed;
};

const detectLayout = (output: number[], numPredictions: number, numValues: number): OutputLayout => {
  const classOffset = numValues === 85 ? 5 : 4;
  const numClasses = numValues - classOffset;
  const sampleCount = Math.min(200, numPredictions);

  const scoreStats = (layout: OutputLayout) => {
    let inRange = 0;
    let maxScoreSum = 0;
    for (let i = 0; i < sampleCount; i++) {
      let maxScore = -Infinity;
      for (let c = 0; c < numClasses; c++) {
        const idx = layout === 'predMajor'
          ? i * numValues + classOffset + c
          : (classOffset + c) * numPredictions + i;
        const score = output[idx];
        if (score > maxScore) {
          maxScore = score;
        }
      }
      if (maxScore >= 0 && maxScore <= 1) {
        inRange += 1;
      }
      maxScoreSum += maxScore;
    }
    return { inRange, avgMax: maxScoreSum / sampleCount };
  };

  const predMajorStats = scoreStats('predMajor');
  const classMajorStats = scoreStats('classMajor');

  if (!hasLoggedLayoutStats) {
    console.log('🔎 YOLO score stats', {
      predMajor: predMajorStats,
      classMajor: classMajorStats,
    });
  }

  return classMajorStats.inRange > predMajorStats.inRange ? 'classMajor' : 'predMajor';
};

const logOutputStats = (output: number[]) => {
  if (hasLoggedOutputStats) {
    return;
  }
  hasLoggedOutputStats = true;
  let min = Infinity;
  let max = -Infinity;
  let inRange = 0;
  const sampleCount = Math.min(2000, output.length);
  const step = Math.max(1, Math.floor(output.length / sampleCount));
  let checked = 0;
  for (let i = 0; i < output.length && checked < sampleCount; i += step) {
    const v = output[i];
    if (v < min) min = v;
    if (v > max) max = v;
    if (v >= 0 && v <= 1) {
      inRange += 1;
    }
    checked += 1;
  }
  console.log('🔎 YOLO output stats', {
    min: Number(min.toFixed(4)),
    max: Number(max.toFixed(4)),
    inRangeRatio: Number((inRange / checked).toFixed(3)),
  });
};
