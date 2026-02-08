import { requireOptionalNativeModule } from 'expo-modules-core';

interface TFLiteModuleInterface {
  loadModel(modelPath: string): Promise<boolean>;
  runInference(inputData: number[] | Float32Array | Uint8Array, inputShape: number[]): Promise<number[]>;
  close(): Promise<void>;
}

const TFLiteModule = requireOptionalNativeModule<TFLiteModuleInterface>('TFLiteModule');

export const TFLite = TFLiteModule ?? undefined;

// Helper function to check if TFLite is available
export const isTFLiteAvailable = (): boolean => {
  const moduleExists = TFLiteModule !== undefined && TFLiteModule !== null;
  if (!moduleExists) {
    console.log('🔍 TFLiteModule availability check:', {
      'TFLiteModule via ExpoModules': TFLiteModule,
    });
  }
  return moduleExists;
};

// Helper function to convert Frame to input array for TFLite
// This is a placeholder - adjust based on your model's input requirements
export const frameToInputArray = (frame: {
  width: number;
  height: number;
  pixelFormat: string;
}): { inputData: number[]; inputShape: number[] } => {
  // This is a placeholder implementation
  // You'll need to extract pixel data from the frame based on your model's requirements
  // Common formats: RGB, YUV, grayscale, etc.
  
  // Example for a 224x224 RGB input:
  // inputShape: [1, 224, 224, 3]
  // inputData: flattened array of pixel values normalized to [0, 1] or [-1, 1]
  
  return {
    inputData: [],
    inputShape: [1, 224, 224, 3], // Adjust based on your model
  };
};
