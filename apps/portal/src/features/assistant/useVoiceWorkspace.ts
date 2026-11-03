import { computed, ref, onBeforeUnmount, watch, type Ref } from 'vue';
import { formatBytes } from '../../shared/format-bytes';
import { diagnoseVoicePerformance } from '../../voice-performance-diagnosis';
import { useVoiceRuns } from './useVoiceRuns';
import { useVoiceTransport } from './useVoiceTransport';
import { useVoiceCapture } from './useVoiceCapture';
import { useNativeWakeWord } from './useNativeWakeWord';
import { playAudioBase64 } from './voice-playback';
import { formatMs, formatDb, delta, amplitudeToDb } from './voice-format';

const endpointModeKey = 'energrid.portal.endpointMode';
const lanPortalUrl = 'http://192.168.1.60';
const lanWsUrl = 'ws://192.168.1.60/voice';

function voiceUrlFromApiBase(baseUrl: string) {
  if (!baseUrl) return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/voice`;
  const url = new URL('/voice', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** One voice feature instance shared by the standalone and administrator views. */
export function useVoiceWorkspace(options: {
  apiBase: string; accessToken: Ref<string>;
  eventLog: Ref<string[]>; isLocalLivePreview: boolean;
  onLog: (message: string) => void;
}) {
  const { apiBase, accessToken, onLog: appendLog } = options;
  const defaultWsBase = import.meta.env.VITE_VOICE_WS_URL || voiceUrlFromApiBase(apiBase);
  const endpointMode = ref(options.isLocalLivePreview
    ? 'same-origin' : localStorage.getItem(endpointModeKey) || 'same-origin');
  const canUseLanDirect = computed(() => location.protocol === 'http:');
  const effectiveRouteLabel = computed(() => endpointMode.value === 'lan'
    ? (canUseLanDirect.value ? 'LAN direct' : 'LAN needs HTTP/local HTTPS') : 'Public domain');
  const effectiveWsUrl = computed(() => endpointMode.value === 'lan' && canUseLanDirect.value ? lanWsUrl : defaultWsBase);
  const voiceSetupError = ref('');
  const { voiceRuns, voiceRunsLoading, voiceRunsError, loadVoiceRuns } = useVoiceRuns({ apiBase, accessToken });
  let native: ReturnType<typeof useNativeWakeWord> | null = null;
  let runsRefresh: ReturnType<typeof setTimeout> | null = null;
  const transport = useVoiceTransport({
    accessToken, effectiveWsUrl, onLog: appendLog,
    onAudioChunk: playAudioBase64,
    onWakeTurnFinished: () => native?.finishWakeTurn(),
    onDiagnostic: (metrics, transcript) => diagnoseVoicePerformance(metrics, transcript, voiceSetupError.value),
    onTurnComplete: () => {
      if (runsRefresh) clearTimeout(runsRefresh);
      runsRefresh = setTimeout(() => { runsRefresh = null; void loadVoiceRuns(); }, 250);
    },
  });
  const capture = useVoiceCapture({ transport, voiceSetupError, onLog: appendLog });
  native = useNativeWakeWord({ transport, capture, voiceSetupError, onLog: appendLog });
  const { wsUrl, voiceStatus, transcript, assistant, plan, pendingVoiceAction,
    voiceActionOutcome, metrics, connected, clientTrace, connectVoice,
    disconnectVoice, confirmVoiceAction, cancelVoiceAction } = transport;
  const { recording, startRecording, stopRecording, cleanupAudio } = capture;
  const { nativeWakeAvailable, nativeWakeEnabled, nativeWakeStatus,
    toggleNativeWakeWord } = native;
  const standaloneAssistantOpen = ref(false);
  const assistantTraceRefresh = ref(0);
  const assistantLatestTraceId = ref('');
  const displayVoiceLogs = computed(() => options.eventLog.value.slice(-40));
  function handleAssistantTurnCompleted(traceId: string) {
    assistantLatestTraceId.value = traceId;
    assistantTraceRefresh.value += 1;
  }
  function openStandaloneAssistant() {
    transport.resetTurn();
    voiceSetupError.value = '';
    voiceStatus.value = 'idle';
    standaloneAssistantOpen.value = true;
    void loadVoiceRuns();
  }
  function closeStandaloneAssistant() {
    if (recording.value) void stopRecording();
    standaloneAssistantOpen.value = false;
  }
function setEndpointMode(mode: string) {
  endpointMode.value = mode;
  localStorage.setItem(endpointModeKey, mode);
  wsUrl.value =
    mode === 'lan' && canUseLanDirect.value ? lanWsUrl : defaultWsBase;
  transport.disconnectVoice();
  appendLog(`[portal] route=${effectiveRouteLabel.value} ws=${wsUrl.value}`);
}


const voiceLinkStatus = computed(() => {
  if (connected.value) return { label: 'connected', tone: 'green' };
  if (['idle', 'turn complete'].includes(voiceStatus.value))
    return { label: 'standby', tone: 'blue' };
  return { label: 'offline', tone: 'amber' };
});
const compactMetrics = computed(() => {
  const m = metrics.value;
  if (!m) return [];
  return [
    { label: 'Total', value: formatMs(m.totalMs) },
    { label: 'STT', value: formatMs(m.sttMs) },
    {
      label: 'First text',
      value: formatMs(m.llmFirstDeltaMs ?? m.firstTextMs),
    },
    { label: 'First audio', value: formatMs(m.firstAudioMs) },
    { label: 'TTS', value: formatMs(m.ttsTotalMs) },
    { label: 'Gate', value: m.speechGatePassed ? 'passed' : 'blocked' },
    { label: 'RMS', value: formatDb(m.audioRmsDb) },
    { label: 'Peak', value: formatDb(m.audioPeakDb) },
    { label: 'Chunks', value: `${m.chunkCount ?? 0}` },
  ];
});
const clientDiagnostics = computed(() => {
  const trace = clientTrace.value;
  const clientRms = trace.sampleCount
    ? 20 *
      Math.log10(Math.sqrt(trace.sumSquares / trace.sampleCount) || 0.000001)
    : null;
  return [
    {
      label: 'Socket open',
      value: delta(trace.connectStartAt, trace.connectedAt),
    },
    { label: 'Held', value: delta(trace.recordStartAt, trace.releaseAt) },
    {
      label: 'Server wait',
      value: delta(trace.releaseAt, trace.firstServerEventAt),
    },
    {
      label: 'First transcript',
      value: delta(trace.releaseAt, trace.firstTranscriptAt),
    },
    {
      label: 'First assistant',
      value: delta(trace.releaseAt, trace.firstAssistantTextAt),
    },
    { label: 'First audio', value: delta(trace.releaseAt, trace.firstAudioAt) },
    { label: 'Sent chunks', value: `${trace.audioChunksSent}` },
    { label: 'Sent audio', value: formatBytes(trace.audioBytesSent) },
    { label: 'Client RMS', value: formatDb(clientRms) },
    {
      label: 'Client peak',
      value: formatDb(amplitudeToDb(trace.maxClientPeak)),
    },
  ];
});
const bottleneckMessage = computed(() => {
  return diagnoseVoicePerformance(metrics.value, transcript.value, voiceSetupError.value);
});

  // Sign-out invalidates recording attempts, microphone resources, and delayed history refresh.
  watch(accessToken, () => {
    capture.cancelCapture();
    native?.cancelNativeTurn();
    if (runsRefresh) { clearTimeout(runsRefresh); runsRefresh = null; }
  }, { flush: 'sync' });
  onBeforeUnmount(() => { if (runsRefresh) clearTimeout(runsRefresh); });
  return { wsUrl, voiceStatus, voiceSetupError, transcript, assistant, plan,
    pendingVoiceAction, voiceActionOutcome, metrics, connected, recording,
    voiceRuns, voiceRunsLoading, voiceRunsError, loadVoiceRuns,
    nativeWakeAvailable, nativeWakeEnabled, nativeWakeStatus, toggleNativeWakeWord,
    endpointMode, canUseLanDirect, effectiveRouteLabel, voiceLinkStatus,
    compactMetrics, clientDiagnostics, bottleneckMessage, lanPortalUrl,
    standaloneAssistantOpen, openStandaloneAssistant, closeStandaloneAssistant,
    assistantTraceRefresh, assistantLatestTraceId, handleAssistantTurnCompleted,
    displayVoiceLogs, setEndpointMode, connectVoice, disconnectVoice,
    startRecording, stopRecording, cleanupAudio, confirmVoiceAction, cancelVoiceAction };
}
export type VoiceWorkspace = ReturnType<typeof useVoiceWorkspace>;
