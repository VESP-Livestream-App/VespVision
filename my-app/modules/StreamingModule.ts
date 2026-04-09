import { requireOptionalNativeModule } from 'expo-modules-core';

interface StreamingModuleInterface {
  startStreaming(url: string): Promise<void>;
  stopStreaming(): Promise<void>;
  isStreaming(): boolean;
  getEncodedFrameCount(): number;
  getConnectionStatus(): string;
  addListener(event: string, handler: (payload: { message?: string }) => void): { remove: () => void };
}

const StreamingModule = requireOptionalNativeModule<StreamingModuleInterface>('StreamingModule');

// Bridge native debug logs to Metro console
if (StreamingModule?.addListener) {
  StreamingModule.addListener('onDebugLog', (e) => {
    if (e?.message) console.log(e.message);
  });
}

export const startStreaming = async (url: string): Promise<void> => {
  if (!StreamingModule) {
    console.warn('LOG  📹 StreamingModule not available');
    return;
  }
  await StreamingModule.startStreaming(url);
  console.log('LOG  📹 StreamingModule.startStreaming completed');
};

export const stopStreaming = async (): Promise<void> => {
  if (StreamingModule) {
    await StreamingModule.stopStreaming();
    console.log('LOG  📹 StreamingModule.stopStreaming completed');
  }
};

export const isStreaming = (): boolean => {
  return StreamingModule?.isStreaming() ?? false;
};

export const getEncodedFrameCount = (): number => {
  return StreamingModule?.getEncodedFrameCount() ?? 0;
};

export const getConnectionStatus = (): string => {
  return StreamingModule?.getConnectionStatus() ?? 'unavailable';
};
