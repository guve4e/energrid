<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { startSampleRecording, supportedSampleLabels } from './wake-word-sample-categories';

type RecorderBridge = {
  getSamples?: () => string;
  getRecorderCapabilities?: () => string;
  getReviewSegments?: () => string;
  labelClip?: (clipId: string, label: string, occurrencesJson: string) => boolean;
  deleteClip?: (clipId: string) => boolean;
  getUploadConfig?: () => string;
  configureUpload?: (baseUrl: string, token: string) => string;
  uploadPending?: () => boolean;
  startSampleRecording: (label: string) => void;
  stopSampleRecording: () => void;
  exportSamples: () => void;
};

const props = defineProps<{ recorderBridge?: RecorderBridge }>();
const getRecorderBridge = () => props.recorderBridge ?? window.EnergridWakeWord;
const positive = ref(0);
const negative = ref(0);
const status = ref('idle');
const label = ref('positive');
const recording = ref(false);
const backgroundSupported = ref(false);
const supportedBackgroundCategories = ref(['tv', 'conversation', 'household', 'mixed']);
const nativeAvailable = ref(false);
const elapsedSeconds = ref(0);
const consentConfirmed = ref(false);
const reviewClips = ref<Array<Record<string, any>>>([]);
const reviewCounts = ref<Record<string, number>>({ confirmed_positive: 0, confirmed_negative: 0, uncertain: 0, unlabeled: 0 });
const clipTimes = ref<Record<string, number>>({});
const occurrencesByClip = ref<Record<string, number[]>>({});
const ingestUrl = ref('');
const ingestToken = ref('');
const ingestConfigured = ref(false);
const ingestMessage = ref('');
let recordingStartedAt = 0;
let timer: ReturnType<typeof setInterval> | undefined;

const labels = [
  { value: 'positive', text: 'Wake phrase' },
  { value: 'background:tv', text: 'Bulgarian TV / YouTube' },
  { value: 'background:english_tv', text: 'English TV / YouTube' },
  { value: 'background:conversation', text: 'Ordinary conversation' },
  { value: 'background:household', text: 'Household sounds' },
  { value: 'background:mixed', text: 'Mixed background' },
];
const visibleLabels = computed(() => labels.filter((item) =>
  item.value !== 'background:english_tv' || supportedBackgroundCategories.value.includes('english_tv'),
));
const isBackground = computed(() => label.value.startsWith('background:'));
const recorderMessage = computed(() => {
  if (!nativeAvailable.value) return 'The tablet recorder is unavailable in this app.';
  if (isBackground.value && !backgroundSupported.value) return 'Update the Energrid tablet app to enable background sessions.';
  if (status.value === 'permission_required') return 'Allow microphone access to start recording.';
  if (status.value === 'starting') return 'Starting microphone…';
  if (status.value === 'error') return 'Recording could not start. Check microphone permission and try again.';
  return '';
});

function updateCounts(detail?: { positive?: number; negative?: number; status?: string; category?: string }) {
  if (typeof detail?.positive === 'number') positive.value = detail.positive;
  if (typeof detail?.negative === 'number') negative.value = detail.negative;
  if (typeof detail?.category === 'string' && detail.category.startsWith('background:')) label.value = detail.category;
  if (detail?.status) {
    status.value = detail.status;
    recording.value = detail.status === 'recording';
    if (recording.value && !timer) {
      recordingStartedAt = Date.now();
      timer = setInterval(() => { elapsedSeconds.value = Math.floor((Date.now() - recordingStartedAt) / 1000); }, 1000);
    } else if (!recording.value && timer) {
      clearInterval(timer);
      timer = undefined;
      elapsedSeconds.value = 0;
    }
  }
}

function handleSamples(event: Event) {
  updateCounts((event as CustomEvent).detail);
  if ((event as CustomEvent).detail?.status === 'segment_saved') refreshReview();
}

function record() {
  const bridge = getRecorderBridge();
  if (!bridge) {
    status.value = 'unavailable';
    return;
  }
  if (!recording.value && isBackground.value && !backgroundSupported.value) {
    status.value = 'app_update_required';
    return;
  }
  if (recording.value) bridge.stopSampleRecording();
  else {
    if (isBackground.value && !consentConfirmed.value) {
      status.value = 'consent_required';
      return;
    }
    status.value = 'starting';
    startSampleRecording(bridge, label.value);
  }
}

function shareSamples() {
  getRecorderBridge()?.exportSamples();
}

function refreshReview() {
  try {
    const result = JSON.parse(getRecorderBridge()?.getReviewSegments?.() || '{}');
    reviewClips.value = Array.isArray(result.clips) ? result.clips : [];
    reviewCounts.value = result.counts || reviewCounts.value;
    for (const clip of reviewClips.value) {
      occurrencesByClip.value[clip.clip_id] = Array.isArray(clip.wake_word_occurrences) ? [...clip.wake_word_occurrences] : [];
    }
  } catch { reviewClips.value = []; }
}

function updateLabel(clipId: string, label: string) {
  const occurrences = occurrencesByClip.value[clipId] || [];
  if (getRecorderBridge()?.labelClip?.(clipId, label, JSON.stringify(occurrences))) refreshReview();
}

function updateClipTime(clipId: string, event: Event) {
  clipTimes.value[clipId] = (event.target as HTMLAudioElement).currentTime;
}

function markOccurrence(clipId: string) {
  if (clipTimes.value[clipId] === undefined) return;
  const next = Number(clipTimes.value[clipId].toFixed(2));
  const occurrences = occurrencesByClip.value[clipId] || [];
  if (!occurrences.includes(next)) occurrences.push(next);
  occurrencesByClip.value[clipId] = occurrences;
}

function removeClip(clipId: string) {
  if (!window.confirm('Delete this locally stored recording? This cannot be undone.')) return;
  if (getRecorderBridge()?.deleteClip?.(clipId)) refreshReview();
}

function saveIngestConfig() {
  const bridge = getRecorderBridge();
  if (!bridge?.configureUpload || !ingestUrl.value.trim() || !ingestToken.value) return;
  try {
    const result = JSON.parse(bridge.configureUpload(ingestUrl.value.trim(), ingestToken.value));
    if (!result.ok) throw new Error(result.error || 'Could not save settings');
    ingestConfigured.value = true;
    ingestToken.value = '';
    ingestMessage.value = 'Destination saved securely. Pending segments will retry over the LAN.';
  } catch (error) {
    ingestMessage.value = error instanceof Error ? error.message : 'Could not save settings';
  }
}

function retryUpload() {
  getRecorderBridge()?.uploadPending?.();
  ingestMessage.value = 'Upload queue retry requested.';
}

onMounted(() => {
  const bridge = getRecorderBridge();
  nativeAvailable.value = !!bridge;
  try {
    const capabilities = JSON.parse(bridge?.getRecorderCapabilities?.() || '{}');
    backgroundSupported.value = capabilities.backgroundSessions === true && capabilities.segmentedWav === true;
    supportedBackgroundCategories.value = supportedSampleLabels(capabilities.backgroundCategories);
  } catch {
    backgroundSupported.value = false;
  }
  try {
    updateCounts(JSON.parse(bridge?.getSamples?.() || '{}'));
    const config = JSON.parse(bridge?.getUploadConfig?.() || '{}');
    ingestUrl.value = config.url || '';
    ingestConfigured.value = config.configured === true;
  } catch {
    status.value = 'unavailable';
  }
  refreshReview();
  window.addEventListener('energrid-wake-samples', handleSamples);
});

onBeforeUnmount(() => window.removeEventListener('energrid-wake-samples', handleSamples));
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <section class="wake-sample-tools" aria-label="Wake word sample recorder">
    <div class="wake-sample-copy">
      <strong>Train “Energrid”</strong>
      <span>Recordings stay on this device. Wake-phrase samples stop after 8 seconds; background sessions continue until you stop them.</span>
    </div>
    <div class="wake-sample-actions">
      <select v-model="label" aria-label="Recording label" :disabled="recording">
        <option v-for="item in visibleLabels" :key="item.value" :value="item.value">{{ item.text }}</option>
      </select>
      <label v-if="isBackground && !recording" class="research-consent">
        <input v-model="consentConfirmed" type="checkbox" />
        I have permission to record everyone present. Audio stays on this device until LAN upload is configured.
      </label>
      <button class="secondary" type="button" :disabled="!nativeAvailable || (isBackground && (!backgroundSupported || (!recording && !consentConfirmed)))" @click="record">
        {{ recording ? `Stop recording · ${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, '0')}` : label === 'positive' ? 'Record wake phrase' : 'Start background session' }}
      </button>
      <button class="secondary" type="button" :disabled="positive + negative === 0" @click="shareSamples">
        Share samples
      </button>
      <span class="wake-sample-count">{{ positive }} wake · {{ negative }} background segments · {{ status.replaceAll('_', ' ') }} · background saved locally in 5-minute WAV parts</span>
      <strong v-if="recording" class="wake-recording-label">Recording: {{ labels.find((item) => item.value === label)?.text || label }}</strong>
      <span v-if="recorderMessage" class="wake-sample-message" role="status">{{ recorderMessage }}</span>
    </div>
    <div v-if="recording && isBackground" class="research-live" role="status">
      <span class="research-live-dot"></span> RESEARCH RECORDING ACTIVE · {{ labels.find((item) => item.value === label)?.text }} · {{ Math.floor(elapsedSeconds / 60) }}m {{ elapsedSeconds % 60 }}s · audio is being saved locally
    </div>
    <details class="research-transfer">
      <summary>LAN storage and reviewed recordings</summary>
      <div class="research-warning">Record conversations only with the consent of everyone present. Capture is explicit and local; uploads go only to the LAN address below.</div>
      <div class="research-config">
        <label>Storage server URL<input v-model="ingestUrl" type="url" placeholder="http://192.168.1.60:8765" /></label>
        <label>Upload token<input v-model="ingestToken" type="password" autocomplete="new-password" placeholder="Token from the Linux storage server" /></label>
        <button class="secondary" type="button" @click="saveIngestConfig">Save destination</button>
        <button class="secondary" type="button" :disabled="!ingestConfigured" @click="retryUpload">Retry pending uploads</button>
        <span class="research-message" role="status">{{ ingestMessage || (ingestConfigured ? 'LAN destination configured' : 'Uploads disabled until configured') }}</span>
      </div>
      <div class="research-counts">
        <span v-for="key in ['confirmed_positive', 'confirmed_negative', 'uncertain', 'unlabeled']" :key="key">{{ key.replaceAll('_', ' ') }}: {{ reviewCounts[key] || 0 }}</span>
        <button class="secondary" type="button" @click="refreshReview">Refresh list</button>
      </div>
      <div v-if="reviewClips.length" class="research-clips">
        <article v-for="clip in reviewClips" :key="clip.clip_id" class="research-clip">
          <div class="research-clip-meta">
            <strong>{{ clip.category }} · {{ clip.started_at }}</strong>
            <span>{{ Math.round(Number(clip.duration_seconds || 0)) }} sec · {{ clip.upload_status || 'local only' }} · {{ clip.clip_id }}</span>
          </div>
          <audio controls preload="none" :src="`https://energrid.local/research-audio/${encodeURIComponent(clip.clip_id)}`" @timeupdate="updateClipTime(clip.clip_id, $event)"></audio>
          <div class="research-clip-actions">
            <button class="secondary" type="button" :disabled="clipTimes[clip.clip_id] === undefined" @click="markOccurrence(clip.clip_id)">Mark wake word at playhead</button>
            <button v-for="option in [['confirmed_positive', 'Positive'], ['confirmed_negative', 'Negative'], ['uncertain', 'Unsure'], ['unlabeled', 'Clear label']]" :key="option[0]" class="secondary" type="button" @click="updateLabel(clip.clip_id, option[0])">{{ option[1] }}</button>
            <button class="secondary" type="button" @click="removeClip(clip.clip_id)">Delete</button>
            <span>{{ clip.label }} · {{ clip.label_source }} · wake word at {{ (occurrencesByClip[clip.clip_id] || []).join(', ') || 'not marked' }} sec</span>
          </div>
        </article>
      </div>
      <p v-else class="research-empty">No metadata-backed research segments yet. Older wake samples remain available through Share samples.</p>
    </details>
  </section>
</template>

<style scoped>
.wake-sample-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 0;
  border-top: 1px solid #dce4f2;
  border-bottom: 1px solid #dce4f2;
}
.wake-sample-copy { display: grid; gap: 4px; }
.wake-sample-copy strong { color: #182033; font-size: 14px; }
.wake-sample-copy span, .wake-sample-count { color: #64718a; font-size: 12px; }
.wake-sample-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.wake-sample-actions select { min-width: 190px; max-width: 100%; border: 1px solid #d6dfef; border-radius: 6px; background: white; color: #28344a; padding: 8px 10px; font: inherit; font-size: 12px; }
.wake-sample-actions select:disabled { opacity: .55; }
.research-consent, .research-config label { display: flex; align-items: center; gap: 7px; flex-basis: 100%; color: #75502a; font-size: 12px; }
.research-consent input { width: 16px; height: 16px; }
.research-live { flex-basis: 100%; display: flex; align-items: center; gap: 8px; color: #a33b32; font-weight: 700; font-size: 12px; }
.research-live-dot { width: 9px; height: 9px; border-radius: 50%; background: #d83f36; }
.research-transfer { flex-basis: 100%; border-top: 1px solid #dce4f2; padding-top: 10px; }
.research-transfer summary { cursor: pointer; color: #27344c; font-size: 13px; font-weight: 700; }
.research-warning { margin: 10px 0; padding: 10px; background: #fff7e8; color: #75502a; font-size: 12px; }
.research-config { display: flex; align-items: end; gap: 8px; flex-wrap: wrap; }
.research-config label { flex: 1 1 220px; display: grid; gap: 4px; color: #64718a; }
.research-config input { width: 100%; min-width: 0; border: 1px solid #d6dfef; border-radius: 6px; padding: 8px; font: inherit; font-size: 12px; }
.research-message, .research-empty { color: #64718a; font-size: 12px; }
.research-counts { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0; color: #52617b; font-size: 12px; }
.research-clips { display: grid; gap: 8px; max-height: 460px; overflow: auto; }
.research-clip { display: grid; gap: 8px; border: 1px solid #dce4f2; border-radius: 6px; padding: 10px; }
.research-clip-meta { display: grid; gap: 4px; min-width: 0; }
.research-clip-meta strong { font-size: 12px; }
.research-clip-meta span { color: #64718a; font: 11px ui-monospace, monospace; overflow-wrap: anywhere; }
.research-clip audio { width: 100%; height: 36px; }
.research-clip-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.research-clip-actions span { color: #64718a; font-size: 11px; }
.wake-sample-message { flex-basis: 100%; color: #a33b32; font-size: 12px; }
.wake-recording-label { flex-basis: 100%; color: #a33b32; font-size: 12px; }
@media (max-width: 760px) {
  .wake-sample-tools { align-items: stretch; flex-direction: column; }
  .wake-sample-actions { justify-content: flex-start; }
  .wake-sample-count { flex-basis: 100%; }
}
</style>
