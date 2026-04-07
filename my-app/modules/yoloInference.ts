import { startTimer, withProfiling } from '@/lib/profiler';
import { TFLite, isTFLiteAvailable } from '@/modules/TFLiteModule';
import { CoreML } from '@/modules/CoreMLModule';
import { getActiveBackend } from '@/modules/yoloModel';
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
  // Output plain number[] 0-1 so the native bridge receives [Double] on iOS and List<Double> on Android.
  // Passing Uint8Array can cause iOS bridge to crash or deserialize incorrectly.
  const rgbOrder = options.rgbOrder ?? true;
  const normalize = options.normalize ?? true;
  const scale = normalize ? 1 / 255 : 1;
  const out: number[] = new Array(rgbData.length);

  for (let i = 0; i < rgbData.length; i += 3) {
    const r = rgbData[i];
    const g = rgbData[i + 1];
    const b = rgbData[i + 2];
    const rOut = rgbOrder ? r : b;
    const bOut = rgbOrder ? b : r;
    const gOut = g;
    out[i] = rOut * scale;
    out[i + 1] = gOut * scale;
    out[i + 2] = bOut * scale;
  }

  if (!hasLoggedInputStats) {
    hasLoggedInputStats = true;
    // console.log('🔎 YOLO input stats', {
    //   normalize,
    //   rgbOrder,
    //   firstPixel: [out[0], out[1], out[2]],
    // });
  }

  return out;
});

export const runYoloInference = async (
  rgbData: ArrayLike<number>,
  frameWidth: number,
  frameHeight: number,
  options: PreprocessOptions = {}
): Promise<Detection[]> => {
  const backend = getActiveBackend();
  const inferModule = backend === 'coreml' ? CoreML : TFLite;
  if (!inferModule) {
    // console.warn('No inference backend available (Core ML or TFLite)');
    return [];
  }

  const normalizedInput = preprocessRgb(rgbData, options);
  const inputShape = getYOLOInputShape();
  const timerName = backend === 'coreml' ? 'CoreML.runInference' : 'TFLite.runInference';
  const endInferenceTimer = startTimer(timerName);
  const output = await inferModule.runInference(normalizedInput, inputShape);
  endInferenceTimer();
  
  if (!output) {
    // console.warn('Inference returned no output');
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

/** Exported for native-frame inference path (plugin returns raw output). */
export const normalizeOutputLayout = (output: number[]): number[] => {
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
    // console.log('🔎 YOLO output layout', { layout, numPredictions, numValues });
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
    // console.log('🔎 YOLO score stats', {
    //   predMajor: predMajorStats,
    //   classMajor: classMajorStats,
    // });
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
  // console.log('🔎 YOLO output stats', {
  //   min: Number(min.toFixed(4)),
  //   max: Number(max.toFixed(4)),
  //   inRangeRatio: Number((inRange / checked).toFixed(3)),
  // });
};
