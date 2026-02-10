import { Platform } from 'react-native';
import { TFLite, isTFLiteAvailable } from '@/modules/TFLiteModule';
import { CoreML, isCoreMLAvailable } from '@/modules/CoreMLModule';

export const YOLO_MODEL_FILENAME = 'newer_best_int8.tflite';
export const CORE_ML_MODEL_NAME = 'new_best';

export type InferenceBackend = 'coreml' | 'tflite' | null;
let activeBackend: InferenceBackend = null;

export const getActiveBackend = (): InferenceBackend => activeBackend;

export const loadYoloModel = async (): Promise<boolean> => {
  if (Platform.OS === 'ios' && isCoreMLAvailable() && CoreML) {
    try {
      console.log('🔄 Attempting to load Core ML model:', CORE_ML_MODEL_NAME);
      const loaded = await CoreML.loadModel(CORE_ML_MODEL_NAME);
      if (loaded === true) {
        activeBackend = 'coreml';
        console.log('✅ Core ML model loaded (Neural Engine)');
        return true;
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn('⚠️ Core ML load failed, falling back to TFLite:', msg);
    }
  }

  if (!isTFLiteAvailable() || !TFLite) {
    console.warn('TFLite module is not available');
    return false;
  }

  try {
    console.log('🔄 Loading TFLite model:', YOLO_MODEL_FILENAME);
    const loaded = await TFLite.loadModel(YOLO_MODEL_FILENAME);
    if (loaded === true) {
      activeBackend = 'tflite';
      console.log('✅ TFLite model loaded successfully');
      return true;
    }
    return false;
  } catch (error: unknown) {
    console.error('❌ TFLite loadModel error:', error);
    return false;
  }
};

export const closeYoloModel = async (): Promise<void> => {
  if (activeBackend === 'coreml' && CoreML) {
    try {
      await CoreML.close();
    } catch (error) {
      console.error('❌ Failed to close Core ML model:', error);
    }
  } else if (TFLite) {
    try {
      await TFLite.close();
    } catch (error) {
      console.error('❌ Failed to close TFLite model:', error);
    }
  }
  activeBackend = null;
};
