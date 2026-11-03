import { ref, onBeforeUnmount, type Ref } from 'vue';
import type { useVoiceTransport } from './useVoiceTransport';
import type { useVoiceCapture } from './useVoiceCapture';
import type { NativeWakeWordBridge } from './native-bridge';

// The native Android bridge is optional; ordinary browser voice works without it.
declare global {
  interface Window {
    EnergridWakeWord?: NativeWakeWordBridge;
    energridNativeVoiceAudio?: (base64Pcm: string) => void;
  }
}

export function useNativeWakeWord(options: {
  transport: ReturnType<typeof useVoiceTransport>;
  capture: ReturnType<typeof useVoiceCapture>;
  voiceSetupError: Ref<string>;
  onLog: (message: string) => void;
}) {
  const { transport, capture, voiceSetupError, onLog: appendLog } = options;
  const nativeWakeAvailable = typeof window !== 'undefined' && !!window.EnergridWakeWord;
  const nativeWakeEnabled = ref(false);
  const nativeWakeStatus = ref('unavailable');
  let nativeVoiceTurn = false;
  let nativeVoiceReady = false;
  let nativeVoiceEndPending = false;
  let nativePendingPcm: Int16Array[] = [];
  let nativePendingSamples = 0;

function syncNativeWakeStatus() {
  const bridge = window.EnergridWakeWord;
  if (!bridge) return;
  try {
    const state = JSON.parse(bridge.getStatus()) as { enabled?: boolean; status?: string };
    nativeWakeEnabled.value = state.enabled === true;
    nativeWakeStatus.value = state.status || 'unavailable';
  } catch {
    nativeWakeStatus.value = 'unavailable';
  }
}

function updateNativeWakeStatus(event: Event) {
  const detail = (event as CustomEvent<{ enabled?: boolean; status?: string }>).detail;
  if (typeof detail?.enabled === 'boolean') nativeWakeEnabled.value = detail.enabled;
  if (typeof detail?.status === 'string') nativeWakeStatus.value = detail.status;
}

function toggleNativeWakeWord() {
  const bridge = window.EnergridWakeWord;
  if (!bridge) return;
  const next = !nativeWakeEnabled.value;
  bridge.setEnabled(next);
  nativeWakeEnabled.value = next;
  syncNativeWakeStatus();
}

function queueNativePcm(samples: Int16Array) {
  if (!samples.length) return;
  nativePendingPcm.push(samples);
  nativePendingSamples += samples.length;
  while (nativePendingSamples > 48_000 && nativePendingPcm.length > 1) {
    nativePendingSamples -= nativePendingPcm.shift()!.length;
  }
}

function receiveNativeVoiceAudio(base64Pcm: string) {
  if (!nativeVoiceTurn || !base64Pcm) return;
  try {
    const binary = atob(base64Pcm);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (bytes.byteLength % 2 !== 0) return;
    const pcm = new Int16Array(bytes.buffer);
    if (!nativeVoiceReady || !transport.isVoiceReady()) {
      queueNativePcm(pcm);
      return;
    }
    capture.enqueueAndFlush(pcm);
  } catch {
    appendLog('[audio] invalid native PCM frame discarded');
  }
}

async function startNativeVoiceTurn() {
  if (nativeVoiceTurn) return;
  nativeVoiceTurn = true;
  nativeVoiceReady = false;
  nativeVoiceEndPending = false;
  nativePendingPcm = [];
  nativePendingSamples = 0;
  try {
    await transport.connectVoice();
    if (!transport.isVoiceReady()) throw new Error('Voice connection unavailable');
    capture.beginNativeRecording();
    nativeVoiceReady = true;
    window.EnergridWakeWord?.beginCommandCapture();
    for (const frame of nativePendingPcm) capture.enqueueAndFlush(frame);
    nativePendingPcm = [];
    nativePendingSamples = 0;
    if (nativeVoiceEndPending) endNativeVoiceTurn();
  } catch (error) {
    nativeVoiceTurn = false;
    nativeVoiceReady = false;
    nativePendingPcm = [];
    nativePendingSamples = 0;
    voiceSetupError.value = error instanceof Error ? error.message : 'Native voice connection unavailable';
    transport.voiceStatus.value = 'connection unavailable';
    window.EnergridWakeWord?.assistantTurnFinished();
  }
}

function handleNativeWakeWord() {
  void startNativeVoiceTurn();
}

function endNativeVoiceTurn() {
  if (!nativeVoiceTurn) return;
  if (!nativeVoiceReady) {
    nativeVoiceEndPending = true;
    return;
  }
  nativeVoiceTurn = false;
  nativeVoiceReady = false;
  capture.finishNativeRecording();
}


  function finishWakeTurn() {
    if (!nativeWakeAvailable) return;
    window.EnergridWakeWord?.assistantTurnFinished();
    syncNativeWakeStatus();
  }
  function cancelNativeTurn() {
    nativeVoiceTurn = false;
    nativeVoiceReady = false;
    nativeVoiceEndPending = false;
    nativePendingPcm = [];
    nativePendingSamples = 0;
  }
  function cleanupNativeWake() {
    cancelNativeTurn();
    if (typeof window === 'undefined') return;
    window.removeEventListener('energrid-wake-status', updateNativeWakeStatus);
    window.removeEventListener('energrid-native-wake-word', handleNativeWakeWord);
    window.removeEventListener('energrid-native-command-ended', endNativeVoiceTurn);
    if (window.energridNativeVoiceAudio === receiveNativeVoiceAudio) window.energridNativeVoiceAudio = undefined;
  }
  if (typeof window !== 'undefined') {
    window.energridNativeVoiceAudio = receiveNativeVoiceAudio;
    window.addEventListener('energrid-wake-status', updateNativeWakeStatus);
    window.addEventListener('energrid-native-wake-word', handleNativeWakeWord);
    window.addEventListener('energrid-native-command-ended', endNativeVoiceTurn);
    syncNativeWakeStatus();
  }
  onBeforeUnmount(cleanupNativeWake);
  return { nativeWakeAvailable, nativeWakeEnabled, nativeWakeStatus,
    toggleNativeWakeWord, finishWakeTurn, cleanupNativeWake, cancelNativeTurn };
}
