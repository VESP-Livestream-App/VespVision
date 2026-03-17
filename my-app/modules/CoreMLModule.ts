import { requireOptionalNativeModule } from 'expo-modules-core';

interface CoreMLModuleInterface {
  loadModel(modelName: string): Promise<boolean>;
  runInference(inputData: number[], inputShape: number[]): Promise<number[]>;
  close(): Promise<void>;
}

const CoreMLModule = requireOptionalNativeModule<CoreMLModuleInterface>('CoreMLModule');

export const CoreML = CoreMLModule ?? undefined;

export const isCoreMLAvailable = (): boolean => {
  return CoreML != null;
};
