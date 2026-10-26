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
  supportedMetrics?: Metric[];
}>();

const ranges = [
  { value: '1h', label: '1 hour', milliseconds: 60 * 60_000 },
  { value: '24h', label: '24 hours', milliseconds: 24 * 60 * 60_000 },
  { value: '7d', label: '7 days', milliseconds: 7 * 24 * 60 * 60_000 },
] as const;
const metrics = computed<Metric[]>(() => props.supportedMetrics ?? ['temperature', 'humidity']);
const selectedRange = ref<(typeof ranges)[number]['value']>('24h');
const fields = ref<Partial<Record<Metric, CurrentField>>>({});
const freshnessLimitSeconds = ref(60);
const currentLoading = ref(false);
const currentError = ref('');
const historyLoading = ref(false);
const historyError = ref('');
const history = ref<Partial<Record<Metric, HistoryResponse>>>({});
const hoveredPoints = ref<Partial<Record<Metric, Measurement>>>({});
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

function axisTimeLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown time';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric' }).format(date);
}

function chartRows(metric: Metric): Measurement[] {
  return (history.value[metric]?.measurements ?? [])
    .filter(row => row.quality === 'measured' && typeof row.value === 'number' && Number.isFinite(row.value) &&
      Number.isFinite(Date.parse(row.observedAt)))
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
}

function chartStatistics(metric: Metric) {
  const values = chartRows(metric).map(row => row.value as number).sort((left, right) => left - right);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  return { minimum: values[0], median, maximum: values[values.length - 1], count: values.length };
}

function measurementValue(item: Measurement | undefined): string {
  return typeof item?.value === 'number' && Number.isFinite(item.value) ? item.value.toFixed(1) : '—';
}

function setHoveredPoint(metric: Metric, item?: Measurement) {
  hoveredPoints.value = { ...hoveredPoints.value, [metric]: item };
}

function pointAriaLabel(metric: Metric, item: Measurement): string {
  return `${labelFor(metric)} ${measurementValue(item)} ${historyUnit(metric)} at ${timeLabel(item.observedAt)}`;
}

function chartBounds(metric: Metric) {
  const values = chartRows(metric).map(row => row.value as number);
  if (!values.length) return { low: 0, middle: 0.5, high: 1 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.12, Math.abs(max || 1) * 0.01, 0.1);
  const low = min - pad;
  const high = max + pad;
  return { low, middle: (low + high) / 2, high };
}

function pointPosition(metric: Metric, item: Measurement) {
  const range = selectedRangeDefinition.value.milliseconds;
  const age = Math.max(0, Math.min(range, Date.now() - Date.parse(item.observedAt)));
  const x = 46 + ((range - age) / range) * 304;
  const bounds = chartBounds(metric);
  const y = 136 - (((item.value as number) - bounds.low) / (bounds.high - bounds.low)) * 112;
  return { x, y };
}

/** Draw lines only across nearby observations; large collection gaps remain visibly disconnected. */
function chartSegments(metric: Metric): Array<{ key: string; path: string }> {
  const rows = chartRows(metric);
  const maximumConnectedGap = Math.max(5 * 60_000, selectedRangeDefinition.value.milliseconds / 20);
  const groups: Measurement[][] = [];
  for (const row of rows) {
    const previousGroup = groups.at(-1);
    const previous = previousGroup?.at(-1);
    if (!previousGroup || !previous || Date.parse(row.observedAt) - Date.parse(previous.observedAt) > maximumConnectedGap) {
      groups.push([row]);
    } else {
      previousGroup.push(row);
    }
  }
  return groups.filter(group => group.length > 1).map(group => ({
    key: `${group[0].observedAt}-${group.at(-1)?.observedAt}`,
    path: group.map((row, index) => {
      const point = pointPosition(metric, row);
      return `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    }).join(' '),
  }));
}

const selectedRangeDefinition = computed(() => ranges.find(range => range.value === selectedRange.value) ?? ranges[1]);
function historyUnit(metric: Metric): string {
  const unit = history.value[metric]?.unit;
  return unit === 'Cel' ? '°C' : unit || unitFor(metric);
}
const authorizedMetrics = computed(() => metrics.value.filter(metric =>
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

watch(() => [props.deviceId, props.apiBase, props.accessToken, props.supportedMetrics?.join(',')], () => {
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
        <strong>{{ currentLoading ? '…' : currentValue(metric) }}<small v-if="currentValue(metric) !== '—'"> {{ unitFor(metric) }}</small></strong>
        <span :class="['freshness-state', `freshness-${freshnessLabel(metric).toLowerCase()}`]">{{ currentLoading ? 'Loading' : freshnessLabel(metric) }}</span>
        <time v-if="observationTimestamp(fields[metric])" :datetime="observationTimestamp(fields[metric]) || undefined">
          Last observed {{ timeLabel(observationTimestamp(fields[metric])!) }}
        </time>
        <time v-else>No observation timestamp</time>
      </article>
    </div>
    <p v-if="!currentLoading && !currentError && authorizedMetrics.length === 0" class="measurement-muted">
      No authorized {{ metrics.map(labelFor).join(' or ').toLowerCase() }} observations are available.
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
          <div class="chart-plot">
          <svg viewBox="0 0 360 180" role="group" :aria-label="`${labelFor(metric)} history, ${selectedRangeDefinition.label}`">
            <line v-for="tick in [chartBounds(metric).high, chartBounds(metric).middle, chartBounds(metric).low]"
              :key="`grid-${tick}`" x1="46" :y1="pointPosition(metric, { observedAt: new Date().toISOString(), value: tick, unit: '', quality: 'measured' }).y"
              x2="350" :y2="pointPosition(metric, { observedAt: new Date().toISOString(), value: tick, unit: '', quality: 'measured' }).y" class="chart-grid" />
            <text x="1" y="18">{{ chartBounds(metric).high.toFixed(1) }}</text>
            <text x="1" y="137">{{ chartBounds(metric).low.toFixed(1) }}</text>
            <path v-for="segment in chartSegments(metric)" :key="segment.key" :d="segment.path" class="chart-line-segment" />
            <circle
              v-for="item in chartRows(metric)"
              :key="`${item.observedAt}-${item.value}`"
              :cx="pointPosition(metric, item).x"
              :cy="pointPosition(metric, item).y"
              r="4.2"
              class="chart-point"
              tabindex="0"
              :aria-label="pointAriaLabel(metric, item)"
              @pointerenter="setHoveredPoint(metric, item)"
              @pointerleave="setHoveredPoint(metric)"
              @focus="setHoveredPoint(metric, item)"
              @blur="setHoveredPoint(metric)"
            ><title>{{ pointAriaLabel(metric, item) }}</title></circle>
            <line x1="46" y1="136" x2="350" y2="136" class="chart-axis" />
            <text x="46" y="162">{{ axisTimeLabel(new Date(Date.now() - selectedRangeDefinition.milliseconds).toISOString()) }}</text>
            <text x="350" y="162" text-anchor="end">{{ axisTimeLabel(new Date().toISOString()) }}</text>
          </svg>
          <div v-if="hoveredPoints[metric]" class="chart-tooltip" role="status">
            <strong>{{ measurementValue(hoveredPoints[metric]) }} {{ historyUnit(metric) }}</strong>
            <time>{{ timeLabel(hoveredPoints[metric]!.observedAt) }}</time>
          </div>
          </div>
          <div v-if="chartStatistics(metric)" class="chart-summary" :aria-label="`${labelFor(metric)} summary for ${selectedRangeDefinition.label}`">
            <div><span>Min</span><strong>{{ chartStatistics(metric)!.minimum.toFixed(1) }} <small>{{ historyUnit(metric) }}</small></strong></div>
            <div><span>Median</span><strong>{{ chartStatistics(metric)!.median.toFixed(1) }} <small>{{ historyUnit(metric) }}</small></strong></div>
            <div><span>Max</span><strong>{{ chartStatistics(metric)!.maximum.toFixed(1) }} <small>{{ historyUnit(metric) }}</small></strong></div>
          </div>
          <p class="chart-sampling-note">Blue dots are saved readings. Lines connect nearby readings; long gaps stay unconnected.</p>
        </template>
        <p v-else class="measurement-muted">No {{ labelFor(metric).toLowerCase() }} history in this range.</p>
      </article>
    </div>
    <p v-else-if="!historyLoading && !historyError" class="measurement-muted">History is unavailable until an authorized measurement is observed.</p>
  </section>
</template>

<style scoped>
.device-measurements { display: grid; gap: 12px; min-width: 0; color: var(--eg-text, #111827); }
.measurement-connectivity { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; color: var(--eg-muted, #58677e); font-size: 12px; }
.measurement-connectivity strong { color: var(--eg-success, #138a59); }
.measurement-connectivity .connection-disconnected { color: var(--eg-danger, #b42318); }
.measurement-separator { opacity: .55; }
.current-measurement-grid, .measurement-charts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.current-measurement, .measurement-chart { min-width: 0; border: 1px solid var(--eg-border, #d8e0ec); border-radius: var(--eg-card-radius, 12px); background: var(--eg-surface, #fff); padding: 12px; }
.current-measurement { display: grid; gap: 6px; }
.current-measurement > span:first-child, .measurement-chart h6 { color: var(--eg-muted, #58677e); font-size: 12px; font-weight: 650; }
.current-measurement strong { font-size: clamp(20px, 4vw, 25px); line-height: 1.2; }
.current-measurement small { color: var(--eg-muted, #58677e); font-size: 12px; font-weight: 600; }
.current-measurement time { color: var(--eg-muted, #58677e); font-size: 11px; }
.freshness-state { width: fit-content; border-radius: 999px; padding: 3px 8px; font-size: 11px; background: var(--eg-surface-soft, #f5f8fc); color: var(--eg-muted, #58677e); }
.freshness-fresh { background: var(--eg-success-soft, #e8f7ef); color: var(--eg-success, #138a59); }
.freshness-stale { background: var(--eg-warning-soft, #fff6e8); color: var(--eg-warning, #a45b08); }
.measurement-history-heading, .measurement-chart header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.measurement-history-heading h5, .measurement-chart h6 { margin: 0; }
.measurement-history-heading p, .chart-sampling-note { margin: 3px 0 0; color: var(--eg-muted, #58677e); font-size: 11px; }
.measurement-range { display: flex; flex-wrap: wrap; gap: 4px; }
.measurement-range button { min-height: 40px; border: 1px solid var(--eg-border, #d8e0ec); background: var(--eg-surface, #fff); border-radius: var(--eg-control-radius, 8px); padding: 6px 9px; color: inherit; font: inherit; font-size: 11px; cursor: pointer; }
.measurement-range button[aria-pressed="true"] { border-color: var(--eg-blue, #2863e6); background: var(--eg-blue-soft, #eef4ff); color: var(--eg-blue, #2863e6); }
.chart-plot { position: relative; }
.measurement-chart svg { display: block; width: 100%; height: auto; margin-top: 8px; overflow: visible; }
.chart-axis { stroke: var(--eg-border, #d8e0ec); stroke-width: 1.25; }
.chart-grid { stroke: var(--eg-border, #d8e0ec); stroke-width: 1; stroke-dasharray: 3 5; opacity: .75; }
.chart-line-segment { fill: none; stroke: var(--eg-blue, #2863e6); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.chart-point { fill: var(--eg-blue, #2863e6); stroke: var(--eg-surface, #fff); stroke-width: 1.5; cursor: crosshair; vector-effect: non-scaling-stroke; }
.chart-point:focus { outline: none; stroke: var(--eg-text, #111827); stroke-width: 2.5; }
.measurement-chart svg text { fill: var(--eg-muted, #58677e); font-size: 12px; }
.chart-tooltip { position: absolute; z-index: 1; top: 8px; right: 8px; display: grid; gap: 2px; border: 1px solid var(--eg-border, #d8e0ec); border-radius: 8px; background: var(--eg-surface, #fff); box-shadow: 0 4px 16px rgb(15 23 42 / 12%); padding: 7px 10px; font-size: 12px; pointer-events: none; }
.chart-tooltip strong { color: var(--eg-text, #111827); font-size: 14px; }
.chart-tooltip time { color: var(--eg-muted, #58677e); }
.chart-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; margin-top: 4px; }
.chart-summary > div { display: grid; gap: 3px; min-width: 0; border: 1px solid var(--eg-border, #d8e0ec); border-radius: 8px; background: var(--eg-surface-soft, #f5f8fc); padding: 7px 9px; }
.chart-summary span { color: var(--eg-muted, #58677e); font-size: 12px; }
.chart-summary strong { color: var(--eg-text, #111827); font-size: 15px; white-space: nowrap; }
.chart-summary small { color: var(--eg-muted, #58677e); font-size: 11px; font-weight: 600; }
.measurement-muted { margin: 0; color: var(--eg-muted, #58677e); font-size: 12px; }
.measurement-error { margin: 0; color: var(--eg-danger, #b42318); font-size: 12px; }
.measurement-range button:focus-visible { outline: 2px solid var(--eg-blue, #2863e6); outline-offset: 2px; }
@media (max-width: 560px) {
  .current-measurement-grid, .measurement-charts { grid-template-columns: minmax(0, 1fr); }
  .measurement-history-heading { align-items: flex-start; flex-direction: column; }
  .measurement-range { width: 100%; }
  .measurement-range button { flex: 1; }
}
</style>
