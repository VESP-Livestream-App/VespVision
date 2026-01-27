import { TFLite, isTFLiteAvailable } from '@/modules/TFLiteModule';

export const YOLO_MODEL_FILENAME = 'yolo26n_float32.tflite';

export const loadYoloModel = async (): Promise<boolean> => {
  if (!isTFLiteAvailable()) {
    console.warn('TFLite module is not available');
    return false;
  }

  if (!TFLite) {
    console.error('❌ TFLite module is undefined');
    return false;
  }

  try {
    console.log('🔄 Attempting to load TFLite model:', YOLO_MODEL_FILENAME);
    console.log('🔄 TFLite module available:', isTFLiteAvailable());
    console.log('🔄 TFLite module:', TFLite ? 'exists' : 'undefined');

    const loaded = await TFLite.loadModel(YOLO_MODEL_FILENAME);
    console.log('🔄 loadModel returned:', loaded, 'type:', typeof loaded);

    if (loaded === true) {
      console.log('✅ TFLite model loaded successfully');
      return true;
    }

    console.error('❌ Failed to load TFLite model - returned:', loaded);
    console.error('❌ Return type:', typeof loaded);
    return false;
  } catch (error: any) {
    console.error('❌ loadModel threw an error:');
    console.error('   Code:', error?.code);
    console.error('   Message:', error?.message);
    console.error('   Native Error:', error?.nativeError);
    console.error('   Full error:', error);
    return false;
  }
};

export const closeYoloModel = async (): Promise<void> => {
  if (!isTFLiteAvailable()) {
    return;
  }

  try {
    await TFLite?.close();
  } catch (error) {
    console.error('❌ Failed to close TFLite model:', error);
  }
};
