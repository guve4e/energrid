import { ref, onBeforeUnmount, type Ref } from 'vue';
import { microphoneRequestError, microphoneSetupError, stopMicrophoneStream } from '../../voice-microphone';
import { formatBytes } from '../../shared/format-bytes';
import { delta } from './voice-format';
import { resampleToPcm16 } from './voice-pcm';
import type { useVoiceTransport } from './useVoiceTransport';

/** Microphone resource ownership and PCM16 capture; does not authorize device actions. */
export function useVoiceCapture(options: {
  transport: ReturnType<typeof useVoiceTransport>;
  voiceSetupError: Ref<string>;
  onLog: (message: string) => void;
}) {
  const { transport, voiceSetupError, onLog: appendLog } = options;
  const recording = ref(false);
  let audioContext: AudioContext | null = null;
  let mediaStream: MediaStream | null = null;
  let recordingAttempt = 0;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let pcmQueue: number[] = [];
  const flushSamples = 4096;

async function startRecording(event?: PointerEvent) {
  if (recording.value) return;
  event?.preventDefault();
  if (event?.currentTarget instanceof HTMLElement) {
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  const attempt = ++recordingAttempt;
  voiceSetupError.value = microphoneSetupError(
    window.isSecureContext,
    typeof navigator.mediaDevices?.getUserMedia === 'function',
  ) || '';
  if (voiceSetupError.value) {
    transport.voiceStatus.value = 'microphone unavailable';
    appendLog(`[audio] ${voiceSetupError.value}`);
    return;
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    mediaStream = stream;
  } catch (error) {
    voiceSetupError.value = microphoneRequestError(error);
    transport.voiceStatus.value = 'microphone unavailable';
    appendLog(`[audio] ${voiceSetupError.value}`);
    return;
  }
  if (attempt !== recordingAttempt) {
    stopMicrophoneStream(stream);
    if (mediaStream === stream) mediaStream = null;
    return;
  }

  try {
    await transport.connectVoice();
  } catch {
    stopMicrophoneStream(stream);
    if (mediaStream === stream) mediaStream = null;
    voiceSetupError.value =
      'The voice service could not be reached. Check that the API is running and that Domain is routed to it, then try again.';
    transport.voiceStatus.value = 'connection unavailable';
    appendLog('[voice] connection failed; microphone released');
    return;
  }
  if (attempt !== recordingAttempt) {
    stopMicrophoneStream(stream);
    if (mediaStream === stream) mediaStream = null;
    return;
  }
  if (!transport.isVoiceReady()) {
    stopMicrophoneStream(stream);
    if (mediaStream === stream) mediaStream = null;
    voiceSetupError.value =
      'The voice connection closed before recording could start. Check the API route and try again.';
    transport.voiceStatus.value = 'connection unavailable';
    appendLog('[voice] connection closed before recording; microphone released');
    return;
  }
  transport.resetTurn();
  pcmQueue = [];
  recording.value = true;
  transport.startClientRecording();
  appendLog('[audio] recording started');

  try {
  audioContext = new AudioContext();
  source = audioContext.createMediaStreamSource(stream);
  processor = audioContext.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (event) => {
    if (
      !recording.value ||
      !transport.isVoiceReady() ||
      !audioContext
    )
      return;
    const input = event.inputBuffer.getChannelData(0);
    transport.trackClientAudio(input);
    const pcm16 = resampleToPcm16(input, audioContext.sampleRate);
    enqueueAndFlush(pcm16);
  };
  source.connect(processor);
  processor.connect(audioContext.destination);
  } catch (error) {
    recording.value = false;
    voiceSetupError.value = error instanceof Error ? error.message : 'Audio capture could not start.';
    transport.voiceStatus.value = 'microphone unavailable';
    transport.disconnectVoice();
    await cleanupAudio();
  }
}

async function stopRecording(event?: PointerEvent) {
  event?.preventDefault();
  if (
    event?.currentTarget instanceof HTMLElement &&
    event.currentTarget.hasPointerCapture(event.pointerId)
  ) {
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
  recordingAttempt += 1;
  if (!recording.value) return;
  recording.value = false;
  transport.finishClientRecording();
  flushPcm(true);
  if (transport.sendEndOfTurn()) {
    appendLog(
      `[audio] released, turn sent chunks=${transport.clientTrace.value.audioChunksSent} bytes=${formatBytes(transport.clientTrace.value.audioBytesSent)} held=${delta(transport.clientTrace.value.recordStartAt, transport.clientTrace.value.releaseAt)}`,
    );
  }
  await cleanupAudio();
}

function enqueueAndFlush(pcm16: Int16Array) {
  for (const sample of pcm16) pcmQueue.push(sample);
  flushPcm(false);
}

function flushPcm(force: boolean) {
  while (
    transport.isVoiceReady() &&
    (pcmQueue.length >= flushSamples || (force && pcmQueue.length > 0))
  ) {
    const size = force ? pcmQueue.length : flushSamples;
    const chunk = new Int16Array(pcmQueue.splice(0, size));
    transport.sendPcmChunk(chunk);
  }
}

async function cleanupAudio() {
  processor?.disconnect();
  source?.disconnect();
  mediaStream?.getTracks().forEach((track) => track.stop());
  await audioContext?.close();
  processor = null;
  source = null;
  mediaStream = null;
  audioContext = null;
}


  function beginNativeRecording() {
    transport.resetTurn();
    pcmQueue = [];
    recording.value = true;
    transport.startClientRecording();
  }
  function finishNativeRecording() {
    recording.value = false;
    transport.finishClientRecording();
    flushPcm(true);
    transport.sendEndOfTurn();
  }
  function cancelCapture() {
    recordingAttempt += 1;
    recording.value = false;
    pcmQueue = [];
    void cleanupAudio();
  }
  onBeforeUnmount(cancelCapture);
  return { recording, startRecording, stopRecording, cleanupAudio,
    beginNativeRecording, finishNativeRecording, enqueueAndFlush, cancelCapture };
}
