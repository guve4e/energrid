import { ref, watch, onBeforeUnmount, type Ref } from 'vue';
import { closeCompletedTurnSocket } from '../../voice-turn-socket';
import type { PendingVoiceAction, VoiceMetrics } from './voice-types';
import { confirmationOutcome, delta, formatEvent } from './voice-format';

export type VoiceTransportOptions = {
  accessToken: Ref<string>;
  effectiveWsUrl: Ref<string>;
  onLog: (message: string) => void;
  onTurnComplete: () => void;
  onDiagnostic: (metrics: VoiceMetrics | null, transcript: string) => string;
  onAudioChunk: (base64: string, format?: string) => void;
  onWakeTurnFinished: () => void;
};

/** Owns one authenticated voice WebSocket, its turn state, and server event mapping. */
export function useVoiceTransport(options: VoiceTransportOptions) {
  const { accessToken, onLog: appendLog, onTurnComplete, onAudioChunk, onWakeTurnFinished } = options;
  const effectiveWsUrl = options.effectiveWsUrl;
  const wsUrl = ref(effectiveWsUrl.value);
  const voiceStatus = ref('idle');
  const transcript = ref('');
  const assistant = ref('');
  const plan = ref('');
  const pendingVoiceAction = ref<PendingVoiceAction | null>(null);
  const voiceActionOutcome = ref('');
  const metrics = ref<VoiceMetrics | null>(null);
  const connected = ref(false);
  let ws: WebSocket | null = null;
  let voiceAuthenticated = false;
  const clientTrace = ref({
    connectStartAt: 0, connectedAt: 0, recordStartAt: 0, releaseAt: 0,
    firstServerEventAt: 0, firstTranscriptAt: 0, firstAssistantTextAt: 0,
    firstAudioAt: 0, audioChunksSent: 0, audioBytesSent: 0,
    maxClientPeak: 0, sumSquares: 0, sampleCount: 0,
  });

function resetTurn() {
  transcript.value = '';
  assistant.value = '';
  plan.value = '';
  metrics.value = null;
  clientTrace.value = {
    connectStartAt: 0,
    connectedAt: 0,
    recordStartAt: 0,
    releaseAt: 0,
    firstServerEventAt: 0,
    firstTranscriptAt: 0,
    firstAssistantTextAt: 0,
    firstAudioAt: 0,
    audioChunksSent: 0,
    audioBytesSent: 0,
    maxClientPeak: 0,
    sumSquares: 0,
    sampleCount: 0,
  };
}

function connectVoice() {
  if (!accessToken.value) return Promise.reject(new Error('Sign in to use voice.'));
  if (ws?.readyState === WebSocket.OPEN && voiceAuthenticated)
    return Promise.resolve();
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING)
    return waitForVoiceAuthentication(ws);

  wsUrl.value = effectiveWsUrl.value;
  clientTrace.value.connectStartAt = performance.now();
  appendLog(`[voice] connecting ${wsUrl.value}`);
  const socket = new WebSocket(wsUrl.value);
  ws = socket;
  voiceAuthenticated = false;
  socket.binaryType = 'arraybuffer';
  attachVoiceListeners(socket);
  voiceStatus.value = 'connecting';

  socket.addEventListener(
    'open',
    () => {
      if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
      voiceStatus.value = 'authenticating';
      socket.send(
        JSON.stringify({ type: 'authenticate', token: accessToken.value }),
      );
    },
    { once: true },
  );
  socket.addEventListener(
    'error',
    () => {
      if (ws !== socket) return;
      voiceStatus.value = 'socket error';
      appendLog('[voice] socket error');
    },
    { once: true },
  );
  return waitForVoiceAuthentication(socket);
}

function waitForVoiceAuthentication(socket: WebSocket): Promise<void> {
  if (voiceAuthenticated) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
    };
    const onMessage = (message: MessageEvent) => {
      try {
        const event = JSON.parse(message.data);
        if (event.type === 'authenticated') {
          cleanup();
          resolve();
        } else if (event.type === 'error') {
          cleanup();
          reject(new Error(event.message || 'Voice authorization failed'));
        }
      } catch {
        cleanup();
        reject(new Error('Invalid voice server message'));
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Voice authorization failed'));
    };
    const timeout = setTimeout(() => {
      cleanup();
      socket.close();
      reject(new Error('Voice authorization timed out'));
    }, 15000);

    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose, { once: true });
  });
}

function attachVoiceListeners(socket: WebSocket) {
  socket.addEventListener('close', () => {
    if (ws !== socket) return;
    connected.value = false;
    voiceAuthenticated = false;
    if (voiceStatus.value !== 'turn complete') voiceStatus.value = 'closed';
    pendingVoiceAction.value = null;
    ws = null;
    appendLog('[voice] closed');
  });

  socket.addEventListener('error', () => {
    if (ws !== socket) return;
    voiceStatus.value = 'socket error';
    appendLog('[voice] socket error');
  });

  socket.addEventListener('message', (message) => {
    if (ws !== socket) return;
    let event: Record<string, any>;
    try {
      event = JSON.parse(message.data);
    } catch {
      appendLog('[voice] ignored malformed server message');
      return;
    }
    if (!event || typeof event !== 'object') return;
    if (event.type === 'authenticated') {
      voiceAuthenticated = true;
      connected.value = true;
      voiceStatus.value = 'connected';
      clientTrace.value.connectedAt = performance.now();
      appendLog(
        `[voice] authenticated in ${delta(clientTrace.value.connectStartAt, clientTrace.value.connectedAt)}`,
      );
      return;
    }
    if (!voiceAuthenticated && event.type !== 'error') return;
    const now = performance.now();
    if (clientTrace.value.releaseAt && !clientTrace.value.firstServerEventAt) {
      clientTrace.value.firstServerEventAt = now;
    }
    appendLog(formatEvent(event));

    if (event.type === 'stt_final') {
      clientTrace.value.firstTranscriptAt ||= now;
      transcript.value = event.full || event.text || '';
    }
    if (event.type === 'assistant_text_delta') {
      clientTrace.value.firstAssistantTextAt ||= now;
      assistant.value = event.full || '';
    }
    if (event.type === 'assistant_final') assistant.value = event.text || '';
    if (event.type === 'action_confirmation_required') {
      pendingVoiceAction.value = {
        approvalId: event.approvalId,
        expiresAt: event.expiresAt,
        actions: Array.isArray(event.actions) ? event.actions : [],
      };
      voiceActionOutcome.value = '';
      voiceStatus.value = 'awaiting action confirmation';
    }
    if (event.type === 'action_confirmation_result') {
      pendingVoiceAction.value = null;
      voiceActionOutcome.value = confirmationOutcome(event.status, event.results);
      voiceStatus.value = event.status === 'completed' ? 'action resolved' : event.status;
    }
    if (event.type === 'home_action_plan')
      plan.value = JSON.stringify(event.plan, null, 2);
    if (event.type === 'assistant_audio_chunk') {
      clientTrace.value.firstAudioAt ||= now;
      if (typeof event.audioBase64 === 'string') onAudioChunk(event.audioBase64, event.format);
    }
    if (event.type === 'turn_end') {
      metrics.value = event.metrics || null;
      voiceStatus.value = 'turn complete';
      onWakeTurnFinished();
      appendLog(`[diagnostic] ${options.onDiagnostic(metrics.value, transcript.value)}`);
      onTurnComplete();
      if (closeCompletedTurnSocket(socket, ws)) {
        ws = null;
        connected.value = false;
        voiceAuthenticated = false;
        appendLog('[voice] turn session closed; ready for the next request');
      }
    }
    if (event.type === 'error') {
      voiceStatus.value = `error: ${event.message}`;
      onWakeTurnFinished();
    }
  });
}

function disconnectVoice() {
  appendLog('[voice] disconnect requested');
  const oldSocket = ws;
  ws = null;
  oldSocket?.close();
  connected.value = false;
  voiceAuthenticated = false;
  pendingVoiceAction.value = null;
}

function confirmVoiceAction() {
  const pending = pendingVoiceAction.value;
  if (!pending || pending.expiresAt <= Date.now() || !isVoiceReady()) return;
  ws?.send(JSON.stringify({ type: 'confirm_action', approvalId: pending.approvalId }));
  voiceStatus.value = 'executing confirmed action';
}

function cancelVoiceAction() {
  const pending = pendingVoiceAction.value;
  if (!pending || !isVoiceReady()) return;
  ws?.send(JSON.stringify({ type: 'cancel_action', approvalId: pending.approvalId }));
}

function sendPcmChunk(chunk: Int16Array) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !voiceAuthenticated) return false;
  ws.send(chunk.buffer);
  clientTrace.value.audioChunksSent += 1;
  clientTrace.value.audioBytesSent += chunk.byteLength;
  return true;
}
function sendEndOfTurn() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !voiceAuthenticated) return false;
  ws.send(JSON.stringify({ type: 'end_of_turn' }));
  return true;
}
function isVoiceReady() { return ws?.readyState === WebSocket.OPEN && voiceAuthenticated; }
function startClientRecording() { clientTrace.value.recordStartAt = performance.now(); voiceStatus.value = 'recording'; }
function finishClientRecording() { clientTrace.value.releaseAt = performance.now(); voiceStatus.value = 'sending'; }
function trackClientAudio(input: Float32Array) {
  let max = clientTrace.value.maxClientPeak;
  let sumSquares = clientTrace.value.sumSquares;
  for (let i = 0; i < input.length; i += 1) {
    const value = Math.abs(input[i]);
    if (value > max) max = value;
    sumSquares += input[i] * input[i];
  }
  clientTrace.value.maxClientPeak = max;
  clientTrace.value.sumSquares = sumSquares;
  clientTrace.value.sampleCount += input.length;
}


  // A socket authenticated for another session must never remain active.
  watch(accessToken, () => { disconnectVoice(); resetTurn(); }, { flush: 'sync' });
  onBeforeUnmount(disconnectVoice);
  return { wsUrl, voiceStatus, transcript, assistant, plan, pendingVoiceAction,
    voiceActionOutcome, metrics, connected, clientTrace, connectVoice,
    disconnectVoice, confirmVoiceAction, cancelVoiceAction, resetTurn,
    isVoiceReady, sendPcmChunk, sendEndOfTurn, startClientRecording,
    finishClientRecording, trackClientAudio };
}
