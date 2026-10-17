export interface WakeWordRecorderBridge {
  startSampleRecording: (label: string) => void;
}

export function supportedSampleLabels(categories: unknown): string[] {
  return Array.isArray(categories)
    ? categories.filter((item): item is string => typeof item === 'string')
    : ['tv', 'conversation', 'household', 'mixed'];
}

export function startSampleRecording(bridge: WakeWordRecorderBridge, label: string): void {
  bridge.startSampleRecording(label);
}
