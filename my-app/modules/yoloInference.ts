import { startTimer, withProfiling } from '@/lib/profiler';
import { TFLite, isTFLiteAvailable } from '@/modules/TFLiteModule';
import { getYOLOInputShape, parseYOLOOutput, type Detection } from '@/modules/yoloUtils';

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
  // Working version: normalize to 0-1 range for Float32
  const normalize = options.normalize ?? true;
  const rgbOrder = options.rgbOrder ?? true;
  const out: number[] = new Array(rgbData.length);
  let min = 255;
  let max = 0;

  for (let i = 0; i < rgbData.length; i += 3) {
    const r = rgbData[i];
    const g = rgbData[i + 1];
    const b = rgbData[i + 2];
    const rOut = rgbOrder ? r : b;
    const bOut = rgbOrder ? b : r;
    const gOut = g;
    // Normalize to 0-1 range (working version)
    out[i] = normalize ? rOut / 255.0 : rOut;
    out[i + 1] = normalize ? gOut / 255.0 : gOut;
    out[i + 2] = normalize ? bOut / 255.0 : bOut;
    
    if (rOut < min) min = rOut;
    if (gOut < min) min = gOut;
    if (bOut < min) min = bOut;
    if (rOut > max) max = rOut;
    if (gOut > max) max = gOut;
    if (bOut > max) max = bOut;
  }

  if (!hasLoggedInputStats) {
    hasLoggedInputStats = true;
    console.log('🔎 YOLO input stats', {
      normalize,
      rgbOrder,
      rawMin: min,
      rawMax: max,
      firstPixel: [rgbData[0], rgbData[1], rgbData[2]],
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
  
  const endInferenceTimer = startTimer('TFLite.runInference');
  const output = await TFLite.runInference(normalizedInput, inputShape);
  endInferenceTimer();
  
  if (!output) {
    console.warn('TFLite returned no output');
    return [];
  }

  const normalizedOutput = normalizeOutputLayout(output);
  logOutputStats(normalizedOutput);
  return parseYOLOOutput(normalizedOutput, frameWidth, frameHeight, {
    inputSize: 640,
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
