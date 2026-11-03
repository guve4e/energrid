export type NativeWakeWordBridge = {
  getStatus: () => string;
  setEnabled: (enabled: boolean) => void;
  beginCommandCapture: () => void;
  startManualCommandCapture: () => string;
  endManualCommandCapture: () => void;
  assistantTurnFinished: () => void;
};

declare global {
  interface Window {
    EnergridWakeWord?: NativeWakeWordBridge;
    energridNativeVoiceAudio?: (base64Pcm: string) => void;
  }
}
