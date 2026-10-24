<script setup lang="ts">
import { authFetch } from '../../auth/auth-client';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

type Metric = 'temperature' | 'humidity';
type Freshness = 'fresh' | 'stale' | 'invalid';
interface CurrentField {
  value: number | boolean | string;
  sourceId: string;
  receivedAt: string;
  measuredAt?: string;
  ageSeconds: number | null;
  freshness: Freshness;
  authority: 'approved';
}
interface Measurement {
  observedAt: string;
  value: number | null;
  unit: string;
  quality: 'measured' | 'invalid';
}
interface HistoryResponse {
  deviceId: string;
  metric: Metric;
  unit: string | null;
  measurements: Measurement[];
}

const props = defineProps<{
  deviceId: string;
  deviceStatus: string;
  apiBase: string;
  accessToken: string;
}>();

const ranges = [
  { value: '1h', label: '1 hour', milliseconds: 60 * 60_000 },
  { value: '24h', label: '24 hours', milliseconds: 24 * 60 * 60_000 },
  { value: '7d', label: '7 days', milliseconds: 7 * 24 * 60 * 60_000 },
] as const;
const metrics: Metric[] = ['temperature', 'humidity'];
const selectedRange = ref<(typeof ranges)[number]['value']>('24h');
const fields = ref<Partial<Record<Metric, CurrentField>>>({});
const freshnessLimitSeconds = ref(60);
const currentLoading = ref(false);
const currentError = ref('');
const historyLoading = ref(false);
const historyError = ref('');
const history = ref<Partial<Record<Metric, HistoryResponse>>>({});
const snapshotClock = ref(0);
const clockTick = ref(0);
let currentController: AbortController | undefined;
let historyController: AbortController | undefined;
let currentRevision = 0;
let historyRevision = 0;
let ticker: ReturnType<typeof setInterval> | undefined;

const unitFor = (metric: Metric) => metric === 'temperature' ? '°C' : '%RH';
const labelFor = (metric: Metric) => metric === 'temperature' ? 'Temperature' : 'Humidity';
const connectivity = computed(() => {
  const status = props.deviceStatus.toLowerCase();
  if (status === 'online' || status === 'healthy' || status === 'connected') return 'Connected';
  if (status === 'offline' || status === 'disconnected') return 'Disconnected';
  return 'Unknown';
});

function isCurrentFresh(field: CurrentField | undefined): boolean {
  if (!field || field.authority !== 'approved' || field.freshness !== 'fresh' || field.ageSeconds === null) return false;
  const elapsed = snapshotClock.value ? Math.max(0, (clockTick.value - snapshotClock.value) / 1000) : 0;
  return field.ageSeconds + elapsed <= freshnessLimitSeconds.value;
}

function observationTimestamp(field: CurrentField | undefined): string | null {
  if (!field) return null;
  return field.measuredAt || field.receivedAt || null;
}

function currentValue(metric: Metric): string {
  const field = fields.value[metric];
  if (!isCurrentFresh(field) || typeof field?.value !== 'number' || !Number.isFinite(field.value)) return '—';
  return field.value.toFixed(metric === 'temperature' ? 1 : 1);
}

function freshnessLabel(metric: Metric): string {
  const field = fields.value[metric];
  if (!field || field.freshness === 'invalid') return 'Unavailable';
  return isCurrentFresh(field) ? 'Fresh' : 'Stale';
}

function timeLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown time';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function pointPosition(metric: Metric, item: Measurement) {
  const rows = history.value[metric]?.measurements.filter(row =>
    row.quality === 'measured' && typeof row.value === 'number' && Number.isFinite(row.value),
  ) ?? [];
  const value = item.value ?? 0;
  const times = selectedRangeDefinition.value.milliseconds;
  const now = Date.now();
  const age = Math.max(0, Math.min(times, now - Date.parse(item.observedAt)));
  const x = 42 + ((times - age) / times) * 246;
  const values = rows.map(row => row.value as number);
  const min = Math.min(...values, value);
  const max = Math.max(...values, value);
  const pad = Math.max((max - min) * 0.15, Math.abs(max || 1) * 0.02, 0.05);
  const y = 92 - ((value - (min - pad)) / ((max + pad) - (min - pad))) * 66;
  return { x, y };
}

function chartBounds(metric: Metric) {
  const values = (history.value[metric]?.measurements ?? [])
    .filter(row => row.quality === 'measured' && typeof row.value === 'number' && Number.isFinite(row.value))
    .map(row => row.value as number);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.15, Math.abs(max || 1) * 0.02, 0.05);
  return { low: min - pad, high: max + pad };
}

const selectedRangeDefinition = computed(() => ranges.find(range => range.value === selectedRange.value) ?? ranges[1]);
function historyUnit(metric: Metric): string {
  const unit = history.value[metric]?.unit;
  return unit === 'Cel' ? '°C' : unit || unitFor(metric);
}
const authorizedMetrics = computed(() => metrics.filter(metric =>
  fields.value[metric]?.authority === 'approved' &&
  typeof fields.value[metric]?.value === 'number',
));

async function loadCurrent() {
  currentController?.abort();
  const controller = new AbortController();
  currentController = controller;
  const request = ++currentRevision;
  currentLoading.value = true;
  currentError.value = '';
  try {
    const response = await authFetch(
      `${props.apiBase}/portal/devices/${encodeURIComponent(props.deviceId)}/observations`,
      { headers: { Authorization: `Bearer ${props.accessToken}` }, signal: controller.signal },
    );
    if (!response.ok) throw new Error('Current observations are unavailable.');
    const result = await response.json() as {
      deviceId: string;
      freshnessLimitSeconds: number;
      fields: Partial<Record<Metric, CurrentField>>;
    };
    if (result.deviceId !== props.deviceId || !result.fields || typeof result.fields !== 'object') {
      throw new Error('Current observations returned an invalid response.');
    }
    if (request !== currentRevision) return;
    fields.value = result.fields;
    freshnessLimitSeconds.value = Number.isFinite(result.freshnessLimitSeconds)
      ? Math.max(1, result.freshnessLimitSeconds)
      : 60;
    snapshotClock.value = performance.now();
  } catch (error) {
    if (controller.signal.aborted || request !== currentRevision) return;
    currentError.value = error instanceof Error ? error.message : 'Current observations are unavailable.';
    fields.value = {};
  } finally {
    if (request === currentRevision) currentLoading.value = false;
  }
}

async function loadHistory() {
  historyController?.abort();
  const controller = new AbortController();
  historyController = controller;
  const request = ++historyRevision;
  historyLoading.value = true;
  historyError.value = '';
  history.value = {};
  if (!authorizedMetrics.value.length) {
    historyLoading.value = false;
    return;
  }
  const to = new Date();
  const from = new Date(to.getTime() - selectedRangeDefinition.value.milliseconds);
  try {
    const results = await Promise.all(authorizedMetrics.value.map(async metric => {
      const query = new URLSearchParams({ metric, from: from.toISOString(), to: to.toISOString(), limit: '1000' });
      const response = await authFetch(
        `${props.apiBase}/portal/devices/${encodeURIComponent(props.deviceId)}/measurements?${query}`,
        { headers: { Authorization: `Bearer ${props.accessToken}` }, signal: controller.signal },
      );
      if (!response.ok) throw new Error('Measurement history is unavailable.');
      const result = await response.json() as HistoryResponse;
      if (result.deviceId !== props.deviceId || result.metric !== metric || !Array.isArray(result.measurements)) {
        throw new Error('Measurement history returned an invalid response.');
      }
      return [metric, result] as const;
    }));
    if (request === historyRevision) history.value = Object.fromEntries(results);
  } catch (error) {
    if (controller.signal.aborted || request !== historyRevision) return;
    historyError.value = error instanceof Error ? error.message : 'Measurement history is unavailable.';
  } finally {
    if (request === historyRevision) historyLoading.value = false;
  }
}

watch(() => [props.deviceId, props.apiBase, props.accessToken], () => {
  fields.value = {};
  void (async () => { await loadCurrent(); await loadHistory(); })();
});
watch(selectedRange, () => void loadHistory());
onMounted(() => {
  void (async () => { await loadCurrent(); await loadHistory(); })();
  ticker = setInterval(() => { clockTick.value = performance.now(); }, 1000);
});
onBeforeUnmount(() => {
  currentController?.abort();
  historyController?.abort();
  if (ticker) clearInterval(ticker);
});
</script>

<template>
  <section class="device-measurements" aria-label="Current and historical measurements" :aria-busy="currentLoading || historyLoading">
    <div class="measurement-connectivity">
      <span>Device connection</span>
      <strong :class="`connection-${connectivity.toLowerCase()}`">{{ connectivity }}</strong>
      <span class="measurement-separator">·</span>
      <span>Measurement freshness is reported separately</span>
    </div>

    <p v-if="currentError" class="measurement-error" role="alert">{{ currentError }}</p>
    <div class="current-measurement-grid">
      <article v-for="metric in metrics" :key="metric" class="current-measurement">
        <span>{{ labelFor(metric) }}</span>
        <strong>{{ currentLoading ? '…' : currentValue(metric) }}<small v-if="currentValue(metric) !== '—'"> {{ unitFor(metric) }}</small></strong>
        <span :class="['freshness-state', `freshness-${freshnessLabel(metric).toLowerCase()}`]">{{ currentLoading ? 'Loading' : freshnessLabel(metric) }}</span>
        <time v-if="observationTimestamp(fields[metric])" :datetime="observationTimestamp(fields[metric]) || undefined">
          Last observed {{ timeLabel(observationTimestamp(fields[metric])!) }}
        </time>
        <time v-else>No observation timestamp</time>
      </article>
    </div>
    <p v-if="!currentLoading && !currentError && authorizedMetrics.length === 0" class="measurement-muted">
      No authorized temperature or humidity observations are available for this device.
    </p>

    <div class="measurement-history-heading">
      <div><h5>Measurement history</h5><p>Recorded changes and heartbeat samples</p></div>
      <div class="measurement-range" role="group" aria-label="History time range">
        <button v-for="range in ranges" :key="range.value" type="button" :aria-pressed="selectedRange === range.value" @click="selectedRange = range.value">{{ range.label }}</button>
      </div>
    </div>
    <p v-if="historyLoading" class="measurement-muted" role="status">Loading measurement history…</p>
    <p v-else-if="historyError" class="measurement-error" role="alert">{{ historyError }}</p>
    <div v-else-if="authorizedMetrics.length" class="measurement-charts">
      <article v-for="metric in authorizedMetrics" :key="metric" class="measurement-chart">
        <header><h6>{{ labelFor(metric) }}</h6><span>{{ historyUnit(metric) }}</span></header>
        <template v-if="(history[metric]?.measurements.length || 0) > 0">
          <svg viewBox="0 0 300 112" role="img" :aria-label="`${labelFor(metric)} history, ${selectedRangeDefinition.label}`">
            <line x1="42" y1="94" x2="288" y2="94" class="chart-axis" />
            <text x="2" y="20">{{ chartBounds(metric).high.toFixed(1) }}</text>
            <text x="2" y="93">{{ chartBounds(metric).low.toFixed(1) }}</text>
            <circle
              v-for="item in history[metric]?.measurements.filter(row => row.quality === 'measured' && typeof row.value === 'number')"
              :key="`${item.observedAt}-${item.value}`"
              :cx="pointPosition(metric, item).x"
              :cy="pointPosition(metric, item).y"
              r="3.5"
              class="chart-point"
            ><title>{{ timeLabel(item.observedAt) }} · {{ item.value }} {{ unitFor(metric) }}</title></circle>
            <text x="42" y="109">{{ timeLabel(new Date(Date.now() - selectedRangeDefinition.milliseconds).toISOString()) }}</text>
            <text x="288" y="109" text-anchor="end">{{ timeLabel(new Date().toISOString()) }}</text>
          </svg>
          <p class="chart-sampling-note">Each point is a stored measurement; gaps are not interpolated.</p>
        </template>
        <p v-else class="measurement-muted">No {{ labelFor(metric).toLowerCase() }} history in this range.</p>
      </article>
    </div>
    <p v-else-if="!historyLoading && !historyError" class="measurement-muted">History is unavailable until a measurement source is approved and observed.</p>
  </section>
</template>

<style scoped>
.device-measurements { display: grid; gap: 14px; color: var(--text, #182431); }
.measurement-connectivity { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; color: var(--muted, #667486); font-size: 12px; }
.measurement-connectivity strong { color: #087f5b; }
.measurement-connectivity .connection-disconnected { color: #b5473b; }
.measurement-separator { opacity: .55; }
.current-measurement-grid, .measurement-charts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.current-measurement, .measurement-chart { min-width: 0; border: 1px solid var(--border, #dce4eb); border-radius: 12px; background: var(--surface, #fff); padding: 12px; }
.current-measurement { display: grid; gap: 6px; }
.current-measurement > span:first-child, .measurement-chart h6 { color: var(--muted, #667486); font-size: 12px; font-weight: 650; }
.current-measurement strong { font-size: clamp(20px, 5vw, 26px); line-height: 1.2; }
.current-measurement small { color: var(--muted, #667486); font-size: 13px; font-weight: 600; }
.current-measurement time { color: var(--muted, #667486); font-size: 11px; }
.freshness-state { width: fit-content; border-radius: 999px; padding: 2px 8px; font-size: 11px; background: #f0f2f5; color: #556273; }
.freshness-fresh { background: #e7f7ef; color: #087f5b; }
.freshness-stale { background: #fff3df; color: #9a5b00; }
.measurement-history-heading, .measurement-chart header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.measurement-history-heading h5, .measurement-chart h6 { margin: 0; }
.measurement-history-heading p, .chart-sampling-note { margin: 3px 0 0; color: var(--muted, #667486); font-size: 11px; }
.measurement-range { display: flex; flex-wrap: wrap; gap: 4px; }
.measurement-range button { border: 1px solid var(--border, #dce4eb); background: transparent; border-radius: 7px; padding: 6px 8px; color: inherit; font: inherit; font-size: 11px; cursor: pointer; }
.measurement-range button[aria-pressed="true"] { border-color: #2876ce; background: #eaf3ff; color: #175ca5; }
.measurement-chart svg { display: block; width: 100%; height: auto; margin-top: 8px; overflow: visible; }
.chart-axis { stroke: #cbd5df; stroke-width: 1; }
.chart-point { fill: #2876ce; stroke: white; stroke-width: 1.5; }
.measurement-chart svg text { fill: var(--muted, #667486); font-size: 8px; }
.measurement-muted { margin: 0; color: var(--muted, #667486); font-size: 12px; }
.measurement-error { margin: 0; color: #b42318; font-size: 12px; }
@media (max-width: 560px) {
  .current-measurement-grid, .measurement-charts { grid-template-columns: minmax(0, 1fr); }
  .measurement-history-heading { align-items: flex-start; flex-direction: column; }
  .measurement-range { width: 100%; }
  .measurement-range button { flex: 1; }
}
</style>
