<script setup lang="ts">
import { authFetch } from '../../auth/auth-client';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DeviceHealthQueryResult, DeviceHealthMetricAvailability } from '@energrid/domain-devices';

type FirmwareEvent = {
  id: string;
  kind: string;
  observedAt: string;
  summary: string;
  explanation: string;
  confidence: 'confirmed' | 'possible';
};
type FirmwareView = {
  deviceId: string;
  sampledAt: string;
  current: {
    firmwareVersion: string;
    bootSessionId: string;
    uptimeMs: number;
    reset: { reason: string; reasonCode: number; exception: unknown };
    memory: { freeHeapBytes: number | null; heapFragmentationPct: number | null; largestFreeBlockBytes: number | null };
    wifi: { connected: boolean; rssiDbm: number | null; disconnectCount: number; reconnectCount: number };
    sensor: { sampleCount: number; readFailureCount: number };
  } | null;
  lastAttemptAt: string;
  lastSuccessfulContactAt: string | null;
  collectionStatus: 'success' | 'failed';
  snapshots?: unknown[];
  collectionFailures: Array<{
    id: string;
    attemptedAt: string;
    reason: string;
    context?: {
      observer: { id: string; host: string; platform: string; localScopes: Array<{ interfaceName: string; cidr: string; address: string }> };
      target: { endpoint: string; ipAddress: string; networkScopeId: string; networkScopeName: string };
    };
  }>;
  events: FirmwareEvent[];
  restartCount10m: number;
  connectivity: 'connected' | 'disconnected' | 'unknown';
};
type HistoryResponse = { schemaVersion: 1; granularity: string; from: string; to: string; records: unknown[]; analysis: DeviceHealthQueryResult };
type HistoryRange = '1h' | '24h' | '7d' | '30d';
type ViewMode = 'simple' | 'advanced';

const props = defineProps<{ deviceId: string; apiBase: string; accessToken: string }>();
const data = ref<FirmwareView | null>(null);
const available = ref(false);
const loading = ref(false);
const error = ref('');
const history = ref<HistoryResponse | null>(null);
const historyLoading = ref(false);
const historyError = ref('');
const historyRange = ref<HistoryRange>('24h');
const viewMode = ref<ViewMode>('simple');
let timer: ReturnType<typeof setInterval> | undefined;
let controller: AbortController | undefined;
let historyController: AbortController | undefined;
const healthTone = computed(() => {
  if (!data.value || !data.value.current || data.value.collectionStatus === 'failed') return 'is-warning';
  return data.value.events.length ? 'is-warning' : 'is-healthy';
});

function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'Unknown';
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hours}h ${minutes}m` : hours ? `${hours}h ${minutes}m` : `${minutes}m ${seconds % 60}s`;
}

function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date) : 'Unknown time';
}

const selectedAnalysis = computed(() => history.value?.analysis.devices.find(device => device.deviceId === props.deviceId) || null);
const gaugeMetrics = computed(() => selectedAnalysis.value?.metrics.filter(metric => metric.semantics === 'gauge') || []);
const counterMetrics = computed(() => selectedAnalysis.value?.metrics.filter(metric => metric.semantics === 'counter') || []);
const recentFailures = computed(() => selectedAnalysis.value?.failures || []);
const recentEvents = computed(() => selectedAnalysis.value?.events || []);
const rangeOptions: Array<{ id: HistoryRange; label: string }> = [
  { id: '1h', label: '1 hour' }, { id: '24h', label: '24 hours' }, { id: '7d', label: '7 days' }, { id: '30d', label: '30 days' },
];
const metricLabels: Record<string, string> = {
  'wifi.rssi': 'Wi-Fi signal', 'memory.free_heap': 'Free memory', 'memory.fragmentation': 'Memory fragmentation',
  'memory.largest_free_block': 'Largest free memory block', uptime: 'Uptime', 'wifi.disconnect_count': 'Wi-Fi disconnects',
  'wifi.reconnect_count': 'Wi-Fi reconnects', 'sensor.sample_count': 'Sensor samples', 'sensor.read_failure_count': 'Sensor read failures',
};
function metricLabel(name: string): string { return metricLabels[name] || name.replace(/[._]/g, ' '); }
function rangeGranularity(range: HistoryRange): 'raw' | 'hourly' | 'daily' {
  return range === '1h' ? 'raw' : range === '30d' ? 'daily' : 'hourly';
}
function rangeWindow(range: HistoryRange): { from: string; to: string } {
  const width = ({ '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 })[range];
  const now = Date.now();
  const toMs = range === '30d' ? Math.floor(now / 86_400_000) * 86_400_000 :
    range === '1h' ? now : Math.floor(now / 3_600_000) * 3_600_000;
  return { from: new Date(toMs - width).toISOString(), to: new Date(toMs).toISOString() };
}
function isHistoryResponse(value: unknown): value is HistoryResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<HistoryResponse>;
  return response.schemaVersion === 1 && typeof response.granularity === 'string' && Array.isArray(response.records) &&
    !!response.analysis && typeof response.analysis === 'object' && Array.isArray(response.analysis.devices) && Array.isArray(response.analysis.series);
}
async function loadHistory() {
  historyController?.abort();
  const active = new AbortController();
  historyController = active;
  historyLoading.value = true;
  historyError.value = '';
  const window = rangeWindow(historyRange.value);
  const query = new URLSearchParams({
    granularity: rangeGranularity(historyRange.value), deviceId: props.deviceId, from: window.from, to: window.to,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', limit: '1000',
  });
  try {
    const response = await authFetch(`${props.apiBase}/portal/device-health/history?${query}`, {
      headers: { Authorization: `Bearer ${props.accessToken}` }, signal: active.signal,
    });
    if (!response.ok) throw new Error('Device health history could not be loaded.');
    const result: unknown = await response.json();
    if (!isHistoryResponse(result) || result.analysis.devices.some(device => device.deviceId !== props.deviceId)) {
      throw new Error('Device health history returned an invalid or mismatched response.');
    }
    history.value = result;
  } catch (cause) {
    if (active.signal.aborted) return;
    historyError.value = cause instanceof Error ? cause.message : 'Device health history could not be loaded.';
    history.value = null;
  } finally {
    if (!active.signal.aborted) historyLoading.value = false;
  }
}
function chooseRange(range: HistoryRange) {
  if (historyRange.value === range) return;
  historyRange.value = range;
  void loadHistory();
}
function timestampBasisLabel(basis: string | null | undefined): string {
  if (basis === 'server-detection-time') return 'Detected by Energrid';
  if (basis === 'sample-collected') return 'First observed in a collected sample';
  if (basis === 'summary-first-observation') return 'First observed in a summary';
  return 'Timestamp provenance unavailable';
}
function elapsed(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return 'Not established';
  const minutes = Math.floor(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function observerEvidence(failure: FirmwareView['collectionFailures'][number]): string {
  const context = failure.context;
  if (!context) return 'Observer and target details were not recorded for this attempt.';
  const scopes = context.observer.localScopes.map(scope => `${scope.interfaceName} ${scope.cidr}`).join(', ') || 'local scope unavailable';
  return `${context.observer.host} (${context.observer.platform}; ${scopes}) could not reach ${context.target.ipAddress} in ${context.target.networkScopeName || context.target.networkScopeId || 'unknown scope'}.`;
}
type HealthPoint = { at: string; value: number; minimum: number; maximum: number; title: string; source: string };
function healthPoints(metric: DeviceHealthMetricAvailability): HealthPoint[] {
  if (!history.value) return [];
  const points: HealthPoint[] = [];
  for (const item of history.value.analysis.series) {
    if ('sampleId' in item) {
      const value = item.metrics.find(value => value.name === metric.name);
      if (value?.value !== null && value?.value !== undefined && Number.isFinite(value.value)) {
        points.push({ at: item.observedAt, value: value.value, minimum: value.value, maximum: value.value,
          source: value.source, title: `${timestamp(item.observedAt)} · ${value.value} ${value.unit} · ${value.source}` });
      }
    } else if ('bucketStartAt' in item) {
      const value = item.metrics[metric.name];
      if (value?.sampleCount) {
        points.push({ at: value.lastObservedAt, value: value.lastValue, minimum: value.minimum, maximum: value.maximum,
          source: value.source, title: `${timestamp(value.lastObservedAt)} · latest ${value.lastValue} ${value.unit} · range ${value.minimum}–${value.maximum} · ${value.sampleCount} samples · ${value.source}` });
      }
    }
  }
  return points.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
function historyBounds(): { from: number; to: number } {
  return { from: Date.parse(history.value?.from || ''), to: Date.parse(history.value?.to || '') };
}
function chartX(at: string): number {
  const { from, to } = historyBounds();
  if (!Number.isFinite(from) || to <= from) return 40;
  return 40 + (Date.parse(at) - from) / (to - from) * 620;
}
function chartY(value: number, metric: DeviceHealthMetricAvailability): number {
  const stats = metric.statistics;
  const points = healthPoints(metric);
  const low = stats?.minimum ?? Math.min(...points.map(point => point.minimum));
  const high = stats?.maximum ?? Math.max(...points.map(point => point.maximum));
  const padding = low === high ? Math.max(1, Math.abs(low) * 0.05) : 0;
  const min = low - padding;
  const max = high + padding;
  return 162 - ((value - min) / Math.max(1e-9, max - min)) * 130;
}
function chartPaths(metric: DeviceHealthMetricAvailability): string[] {
  const points = healthPoints(metric);
  const granularity = history.value?.granularity;
  const maxGap = granularity === 'raw' ? 90_000 : granularity === 'daily' ? 36 * 3_600_000 : 90 * 60_000;
  const groups: HealthPoint[][] = [];
  for (const point of points) {
    const current = groups[groups.length - 1];
    if (!current || Date.parse(point.at) - Date.parse(current[current.length - 1].at) > maxGap) groups.push([point]);
    else current.push(point);
  }
  return groups.filter(group => group.length > 1).map(group => group.map((point, index) => `${index ? 'L' : 'M'}${chartX(point.at).toFixed(1)},${chartY(point.value, metric).toFixed(1)}`).join(' '));
}
function eventX(at: string): number | null {
  const { from, to } = historyBounds();
  const time = Date.parse(at);
  return Number.isFinite(time) && time >= from && time <= to ? chartX(at) : null;
}
function historyRangeLabel(): string {
  const from = history.value?.from;
  const to = history.value?.to;
  return from && to ? `${timestamp(from)} – ${timestamp(to)}` : '';
}

async function load() {
  controller?.abort();
  const active = new AbortController();
  controller = active;
  loading.value = true;
  error.value = '';
  try {
    const response = await authFetch(`${props.apiBase}/portal/devices/${encodeURIComponent(props.deviceId)}/firmware-diagnostics`, {
      headers: { Authorization: `Bearer ${props.accessToken}` }, signal: active.signal,
    });
    if (!response.ok) throw new Error('Firmware diagnostics could not be loaded.');
    const result = await response.json() as FirmwareView | { deviceId: string; available: false; events: FirmwareEvent[]; restartCount10m: number };
    if (result.deviceId !== props.deviceId) throw new Error('Firmware diagnostics returned a different device.');
    available.value = 'available' in result ? result.available : true;
    data.value = available.value ? result as FirmwareView : null;
  } catch (cause) {
    if (active.signal.aborted) return;
    error.value = cause instanceof Error ? cause.message : 'Firmware diagnostics could not be loaded.';
    data.value = null;
  } finally {
    if (!active.signal.aborted) loading.value = false;
  }
}

watch(() => [props.deviceId, props.apiBase, props.accessToken], () => { void load(); void loadHistory(); });
onMounted(() => {
  void load();
  void loadHistory();
  timer = setInterval(() => { void load(); void loadHistory(); }, 60_000);
});
onBeforeUnmount(() => {
  controller?.abort();
  historyController?.abort();
  if (timer) clearInterval(timer);
});
</script>

<template>
  <section class="firmware-diagnostics" aria-label="Firmware diagnostics" aria-live="polite">
    <div class="firmware-diagnostics-heading">
      <div>
        <span class="firmware-diagnostics-eyebrow">Device diagnostics</span>
        <h4>Device health</h4>
      </div>
      <div class="firmware-diagnostics-actions">
        <span v-if="data" class="firmware-health-pill" :class="healthTone">{{ data.collectionStatus === 'failed' ? 'Observer could not collect' : 'Latest contact succeeded' }}</span>
        <button type="button" class="ghost" :disabled="loading || historyLoading" @click="load(); loadHistory()">{{ loading || historyLoading ? 'Refreshing…' : 'Refresh' }}</button>
      </div>
    </div>
    <p v-if="error" class="firmware-diagnostics-error" role="alert">{{ error }}</p>
    <p v-if="!error && loading && !data" class="firmware-diagnostics-empty" role="status">Loading firmware diagnostics…</p>
    <p v-if="!error && !available && !loading" class="firmware-diagnostics-empty">
      No diagnostic snapshot is available. This requires firmware with the read-only diagnostics endpoint; connectivity and measurement freshness are reported separately.
    </p>
    <template v-if="!error && data && !data.current">
      <p class="firmware-diagnostics-note">No successful firmware snapshot has been collected yet. A failed HTTP attempt does not establish device power or Wi-Fi state.</p>
    </template>
    <template v-if="data && data.current">
      <div class="firmware-summary-grid" aria-label="Health summary">
        <article class="firmware-metric-card"><span>Last successful diagnostic contact</span><strong>{{ timestamp(data.lastSuccessfulContactAt || data.sampledAt) }}</strong></article>
        <article class="firmware-metric-card"><span>Device-reported Wi-Fi</span><strong>{{ data.current.wifi.connected ? 'Connected' : 'Disconnected' }}</strong><small>Reported by device at {{ timestamp(data.sampledAt) }}</small></article>
        <article class="firmware-metric-card"><span>Observer reachability</span><strong>{{ data.collectionStatus === 'failed' ? 'Latest request failed' : 'Latest request succeeded' }}</strong><small>This describes the collector, not device power or Wi-Fi</small></article>
      </div>
      <p v-if="data.collectionStatus === 'failed'" class="firmware-diagnostics-note" role="status">
        Energrid could not reach the configured endpoint on its latest attempt. The last successful device snapshot is preserved; this does not show that the device lost power or Wi-Fi.
      </p>

      <section class="firmware-diagnostics-section health-history" aria-labelledby="health-history-heading">
        <div class="firmware-section-heading health-history-heading">
          <div><h5 id="health-history-heading">Health history</h5><span v-if="history">{{ historyRangeLabel() }} · {{ history.granularity }} data</span></div>
          <div class="health-history-actions">
            <div class="health-range-control" role="group" aria-label="History range">
              <button v-for="option in rangeOptions" :key="option.id" type="button" :aria-pressed="historyRange === option.id" :class="{ selected: historyRange === option.id }" @click="chooseRange(option.id)">{{ option.label }}</button>
            </div>
            <div class="health-mode-control" role="group" aria-label="Health detail level">
              <button type="button" :aria-pressed="viewMode === 'simple'" :class="{ selected: viewMode === 'simple' }" @click="viewMode = 'simple'">Simple</button>
              <button type="button" :aria-pressed="viewMode === 'advanced'" :class="{ selected: viewMode === 'advanced' }" @click="viewMode = 'advanced'">Installer details</button>
            </div>
          </div>
        </div>
        <p v-if="historyLoading" class="firmware-diagnostics-empty" role="status">Loading saved health history…</p>
        <p v-else-if="historyError" class="firmware-diagnostics-error" role="alert">{{ historyError }}</p>
        <template v-else-if="history && selectedAnalysis">
          <template v-if="viewMode === 'simple'">
            <div class="health-home-summary">
              <div><strong>{{ selectedAnalysis.failureCount }}</strong><span>{{ selectedAnalysis.failureCount === 1 ? 'communication problem' : 'communication problems' }} in this period</span></div>
              <div><strong>{{ selectedAnalysis.observedSampleCount.toLocaleString() }}</strong><span>successful diagnostic samples</span></div>
              <div><strong>{{ selectedAnalysis.coverageRatio === null ? 'Unavailable' : `${Math.round(selectedAnalysis.coverageRatio * 100)}%` }}</strong><span>observed coverage of the recorded sample span</span></div>
            </div>
            <p v-if="recentFailures.length" class="firmware-diagnostics-note">Most recent communication problem: {{ recentFailures[recentFailures.length - 1].reason }} at {{ timestamp(recentFailures[recentFailures.length - 1].attemptedAt) }}. A later successful contact is evidence of recovery, not proof of when the device became unavailable.</p>
            <p v-else-if="data.collectionFailures?.length" class="firmware-diagnostics-note">Most recent observer failure: {{ data.collectionFailures[data.collectionFailures.length - 1].reason }} at {{ timestamp(data.collectionFailures[data.collectionFailures.length - 1].attemptedAt) }}. {{ observerEvidence(data.collectionFailures[data.collectionFailures.length - 1]) }}</p>
            <p v-else class="firmware-diagnostics-empty">No communication failures were recorded in this period. Missing samples remain gaps and are not treated as device outages.</p>
          </template>
          <template v-else>
            <div class="health-coverage-line">
              <span>{{ selectedAnalysis.observedSampleCount.toLocaleString() }} samples</span>
              <span>{{ selectedAnalysis.missingSampleCount.toLocaleString() }} expected samples missing</span>
              <span>{{ selectedAnalysis.failureCount }} collection failures</span>
              <span>{{ selectedAnalysis.coverageRatio === null ? 'Coverage unavailable' : `${Math.round(selectedAnalysis.coverageRatio * 100)}% coverage` }}</span>
            </div>
            <p class="firmware-diagnostics-note">Device-reported health values and Energrid observer attempts are separate evidence. Empty ranges and missing points are shown as gaps.</p>
            <div class="health-marker-legend" aria-label="Chart markers"><span><i class="event-key"></i>Reported event</span><span><i class="failure-key"></i>Observer collection failure</span></div>
            <div v-if="gaugeMetrics.length" class="health-chart-grid">
              <article v-for="metric in gaugeMetrics" :key="metric.name" class="health-chart-card">
                <div class="health-chart-title">
                  <div><h6>{{ metricLabel(metric.name) }}</h6><span v-if="metric.statistics">{{ metric.statistics.unit }} · {{ metric.statistics.source }}</span></div>
                  <span v-if="metric.status !== 'available'" class="firmware-evidence-pill is-possible">{{ metric.status === 'unsupported' ? 'Not supported' : 'No samples in range' }}</span>
                  <strong v-else class="health-chart-latest">{{ metric.statistics?.latest.value }} {{ metric.statistics?.unit }}</strong>
                </div>
                <template v-if="metric.status === 'available' && metric.statistics">
                  <svg class="health-chart" viewBox="0 0 700 205" role="img" :aria-label="`${metricLabel(metric.name)} history`" preserveAspectRatio="none">
                    <line v-for="y in [32, 96, 162]" :key="y" x1="40" :y1="y" x2="660" :y2="y" class="health-gridline" />
                    <g v-for="event in recentEvents" :key="`event-${metric.name}-${event.id}`">
                      <line v-if="eventX(event.observedAt) !== null" :x1="eventX(event.observedAt)!" y1="20" :x2="eventX(event.observedAt)!" y2="170" class="health-event-marker" />
                    </g>
                    <g v-for="failure in recentFailures" :key="`failure-${metric.name}-${failure.id}`">
                      <line v-if="eventX(failure.attemptedAt) !== null" :x1="eventX(failure.attemptedAt)!" y1="20" :x2="eventX(failure.attemptedAt)!" y2="170" class="health-failure-marker" />
                    </g>
                    <path v-for="(path, index) in chartPaths(metric)" :key="`${metric.name}-path-${index}`" :d="path" class="health-line" />
                    <g v-for="(point, index) in healthPoints(metric)" :key="`${metric.name}-${point.at}-${index}`">
                      <line v-if="point.minimum !== point.maximum" :x1="chartX(point.at)" :x2="chartX(point.at)" :y1="chartY(point.maximum, metric)" :y2="chartY(point.minimum, metric)" class="health-range-bar" />
                      <circle :cx="chartX(point.at)" :cy="chartY(point.value, metric)" r="3.5" class="health-point"><title>{{ point.title }}</title></circle>
                    </g>
                    <text x="40" y="195" class="health-axis-label">{{ timestamp(history.from) }}</text>
                    <text x="660" y="195" text-anchor="end" class="health-axis-label">{{ timestamp(history.to) }}</text>
                  </svg>
                  <div class="health-chart-stats"><span>Min <b>{{ metric.statistics.minimum }}</b></span><span>Max <b>{{ metric.statistics.maximum }}</b></span><span>Avg <b>{{ metric.statistics.average }}</b></span><span>{{ metric.statistics.count }} values</span></div>
                </template>
                <p v-else class="firmware-diagnostics-empty">{{ metric.status === 'unsupported' ? 'This device does not report this diagnostic.' : 'No value was recorded for this metric in the selected range.' }}</p>
              </article>
            </div>
            <p v-else class="firmware-diagnostics-empty">No numeric health metrics are available for this device in the selected period.</p>

            <section v-if="counterMetrics.length" class="firmware-diagnostics-section" aria-labelledby="health-counter-heading">
              <div class="firmware-section-heading"><h5 id="health-counter-heading">Counters and boot sessions</h5><span>Core reports counters per boot session; values are not averaged across resets.</span></div>
              <div v-for="metric in counterMetrics" :key="metric.name" class="health-counter-row">
                <strong>{{ metricLabel(metric.name) }}</strong>
                <span v-if="metric.status !== 'available'">{{ metric.status === 'unsupported' ? 'Not supported' : 'No samples in range' }}</span>
                <div v-else v-for="counter in metric.counterSeries" :key="`${metric.name}-${counter.bootSessionId}`" class="health-counter-session">
                  <span>Boot <code>{{ counter.bootSessionId }}</code></span>
                  <span>{{ counter.firstValue }} → {{ counter.lastValue }} {{ counter.unit }}</span>
                  <span>{{ counter.resetObserved ? 'Counter decrease observed' : counter.delta === null ? 'Change unavailable across a sample gap' : `Change +${counter.delta}` }}</span>
                </div>
              </div>
            </section>

            <section class="firmware-diagnostics-section" aria-labelledby="health-events-heading">
              <div class="firmware-section-heading"><h5 id="health-events-heading">Events and collection</h5><span>Detection time, estimates and unknown provenance are labeled separately.</span></div>
              <ul v-if="recentEvents.length || recentFailures.length || selectedAnalysis.bootSessionTransitions.length" class="firmware-diagnostics-events health-events">
                <li v-for="event in recentEvents" :key="event.id">
                  <strong>{{ event.summary }}</strong>
                  <p>{{ event.explanation }}</p>
                  <time :datetime="event.observedAt">{{ timestamp(event.observedAt) }} · {{ timestampBasisLabel(event.observedAtBasis) }} · {{ event.source || 'Source unavailable' }}</time>
                  <small v-if="event.detectedAt">Server detected at {{ timestamp(event.detectedAt) }}</small>
                  <small v-if="event.inferredBootAt">Estimated boot time {{ timestamp(event.inferredBootAt.at) }} (collection time minus reported uptime; not an exact reboot time)</small>
                  <small v-if="event.evidenceReferences.length">{{ event.evidenceReferences.length }} linked diagnostic evidence record(s)</small>
                </li>
                <li v-for="transition in selectedAnalysis.bootSessionTransitions" :key="`${transition.from}-${transition.to}-${transition.observedAt}`">
                  <strong>Boot session changed</strong><p>{{ transition.from }} → {{ transition.to }}</p>
                  <time :datetime="transition.observedAt">{{ timestamp(transition.observedAt) }} · {{ timestampBasisLabel(transition.observedAtBasis) }}</time>
                </li>
                <li v-for="failure in recentFailures" :key="failure.id">
                  <strong>Collection problem · {{ failure.reason }}</strong>
                  <p>{{ failure.requestDurationMs == null ? 'Request duration was not recorded.' : `Request took ${failure.requestDurationMs} ms.` }}{{ failure.recoveryObservedAt ? ` Recovery was observed ${elapsed(failure.recoveryObservedAfterMs)} later.` : ' No later successful contact is recorded in this range.' }}</p>
                  <time :datetime="failure.attemptedAt">{{ timestamp(failure.attemptedAt) }} · {{ failure.source }}</time>
                  <small v-if="data.collectionFailures?.length">{{ observerEvidence(data.collectionFailures[data.collectionFailures.length - 1]) }}</small>
                </li>
              </ul>
              <p v-else class="firmware-diagnostics-empty">No events or collection failures were recorded in this period.</p>
            </section>

            <details class="firmware-technical-details">
              <summary>Latest device-reported snapshot</summary>
              <div class="firmware-health-grid">
                <article class="firmware-metric-card"><span>Uptime</span><strong>{{ duration(data.current.uptimeMs) }}</strong></article>
                <article class="firmware-metric-card"><span>Firmware version</span><strong>{{ data.current.firmwareVersion || 'Unavailable' }}</strong></article>
                <article class="firmware-metric-card"><span>Reset reason reported</span><strong>{{ data.current.reset.reason || 'Unavailable' }}</strong><small>Code {{ data.current.reset.reasonCode ?? 'unavailable' }}</small></article>
                <article class="firmware-metric-card"><span>Free memory</span><strong>{{ data.current.memory.freeHeapBytes === null ? 'Unavailable' : `${data.current.memory.freeHeapBytes.toLocaleString()} bytes` }}</strong></article>
                <article class="firmware-metric-card"><span>Fragmentation</span><strong>{{ data.current.memory.heapFragmentationPct === null ? 'Unavailable' : `${data.current.memory.heapFragmentationPct}%` }}</strong></article>
                <article class="firmware-metric-card"><span>Largest free block</span><strong>{{ data.current.memory.largestFreeBlockBytes === null ? 'Unavailable' : `${data.current.memory.largestFreeBlockBytes.toLocaleString()} bytes` }}</strong></article>
                <article class="firmware-metric-card"><span>RSSI</span><strong>{{ data.current.wifi.rssiDbm === null ? 'Unavailable' : `${data.current.wifi.rssiDbm} dBm` }}</strong></article>
                <article class="firmware-metric-card"><span>Wi-Fi disconnects / reconnects</span><strong>{{ data.current.wifi.disconnectCount }} / {{ data.current.wifi.reconnectCount }}</strong></article>
                <article class="firmware-metric-card"><span>Sensor reads / failures</span><strong>{{ data.current.sensor?.sampleCount ?? 'Unavailable' }} / {{ data.current.sensor?.readFailureCount ?? 'Unavailable' }}</strong></article>
                <article class="firmware-metric-card"><span>Boot session</span><strong><code>{{ data.current.bootSessionId }}</code></strong></article>
                <article class="firmware-metric-card"><span>Restarts observed in last 10 minutes</span><strong>{{ data.restartCount10m }}</strong></article>
              </div>
              <p class="firmware-diagnostics-sampled">Snapshot collected {{ timestamp(data.sampledAt) }}. The firmware has no wall-clock sample time.</p>
            </details>
          </template>
        </template>
        <p v-else-if="!historyLoading && !historyError" class="firmware-diagnostics-empty">No diagnostic history is available for this device in the selected range.</p>
      </section>
    </template>
  </section>
</template>

<style scoped>
.firmware-diagnostics { display: grid; gap: 14px; min-width: 0; border: 1px solid var(--eg-border, #d8e0ec); border-radius: var(--eg-card-radius, 12px); padding: 16px; background: var(--eg-surface, #fff); color: var(--eg-text, #111827); }
.firmware-diagnostics-heading, .firmware-section-heading, .firmware-diagnostics-actions, .firmware-event-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 12px; }
.firmware-diagnostics-heading h4, .firmware-section-heading h5 { margin: 3px 0 0; color: var(--eg-text, #111827); }
.firmware-diagnostics-eyebrow { color: var(--eg-muted, #58677e); font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.firmware-section-heading h5 { font-size: 14px; }
.firmware-section-heading > span, .firmware-diagnostics-sampled, .firmware-diagnostics-empty, .firmware-diagnostics-note { color: var(--eg-muted, #58677e); font-size: 12px; line-height: 1.45; }
.firmware-health-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 9px; }
.firmware-memory-grid, .firmware-connectivity-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.firmware-metric-card { display: grid; align-content: start; gap: 5px; min-width: 0; padding: 11px 12px; border: 1px solid var(--eg-border, #d8e0ec); border-radius: var(--eg-control-radius, 8px); background: var(--eg-surface-soft, #f5f8fc); }
.firmware-metric-card span, .firmware-metric-card small { color: var(--eg-muted, #58677e); font-size: 11px; }
.firmware-metric-card strong { overflow-wrap: anywhere; font-size: 13px; font-variant-numeric: tabular-nums; }
.firmware-health-pill, .firmware-evidence-pill { display: inline-flex; align-items: center; width: fit-content; border: 1px solid transparent; border-radius: 999px; padding: 4px 8px; font-size: 11px; font-weight: 700; }
.firmware-health-pill.is-healthy, .firmware-evidence-pill.is-confirmed { color: var(--eg-success, #138a59); background: var(--eg-success-soft, #e8f7ef); }
.firmware-health-pill.is-warning, .firmware-evidence-pill.is-possible { color: var(--eg-warning, #a45b08); background: var(--eg-warning-soft, #fff6e8); }
.firmware-technical-details { border-top: 1px solid var(--eg-border, #d8e0ec); border-bottom: 1px solid var(--eg-border, #d8e0ec); padding: 10px 0; }
.firmware-technical-details > summary { cursor: pointer; color: var(--eg-blue, #2863e6); font-size: 12px; font-weight: 700; }
.firmware-technical-grid { display: grid; gap: 8px; margin: 12px 0 0; }
.firmware-technical-grid div { min-width: 0; }
.firmware-technical-grid dt { color: var(--eg-muted, #58677e); font-size: 11px; }
.firmware-technical-grid dd { margin: 4px 0 0; overflow-wrap: anywhere; font-size: 12px; }
.firmware-diagnostics-events { display: grid; gap: 0; max-height: 210px; overflow-y: auto; overscroll-behavior: auto; touch-action: pan-y; margin: 8px 0 0; padding: 0; list-style: none; border: 1px solid var(--eg-border, #d8e0ec); border-radius: var(--eg-control-radius, 8px); }
.firmware-diagnostics-events li { display: grid; gap: 6px; min-width: 0; padding: 10px 12px; border-bottom: 1px solid var(--eg-border, #d8e0ec); }
.firmware-diagnostics-events li:last-child { border-bottom: 0; }
.firmware-diagnostics-events strong { min-width: 0; overflow-wrap: anywhere; font-size: 12px; }
.firmware-diagnostics-events p { margin: 0; color: var(--eg-text, #111827); font-size: 12px; line-height: 1.45; }
.firmware-diagnostics-events time { color: var(--eg-muted, #58677e); font-size: 11px; }
.firmware-diagnostics-empty, .firmware-diagnostics-error, .firmware-diagnostics-note, .firmware-diagnostics-sampled { margin: 0; }
.firmware-diagnostics-error { color: var(--eg-danger, #b42318); }
.firmware-summary-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.health-history { border-top: 1px solid var(--eg-border, #d8e0ec); padding-top: 13px; }
.health-history-heading { align-items: flex-start; }
.health-history-heading h5 { margin-bottom: 3px; }
.health-history-heading span { color: var(--eg-muted, #58677e); font-size: 11px; }
.health-history-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.health-range-control, .health-mode-control { display: flex; flex-wrap: wrap; gap: 4px; }
.health-range-control button, .health-mode-control button { min-height: 34px; border: 1px solid var(--eg-border, #d8e0ec); border-radius: var(--eg-control-radius, 8px); padding: 6px 10px; background: var(--eg-surface-soft, #f5f8fc); color: var(--eg-text, #111827); cursor: pointer; font: inherit; font-size: 11px; }
.health-range-control button.selected, .health-mode-control button.selected { border-color: var(--eg-blue, #2863e6); color: var(--eg-blue, #2863e6); background: var(--eg-blue-soft, #eff4ff); font-weight: 700; }
.health-home-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.health-home-summary > div { display: grid; gap: 4px; padding: 12px; border: 1px solid var(--eg-border, #d8e0ec); border-radius: var(--eg-control-radius, 8px); background: var(--eg-surface-soft, #f5f8fc); }
.health-home-summary strong { font-size: 20px; font-variant-numeric: tabular-nums; }
.health-home-summary span { color: var(--eg-muted, #58677e); font-size: 11px; }
.health-coverage-line { display: flex; flex-wrap: wrap; gap: 8px 16px; padding: 10px 12px; border-left: 3px solid var(--eg-blue, #2863e6); border-radius: 6px; background: var(--eg-surface-soft, #f5f8fc); color: var(--eg-muted, #58677e); font-size: 11px; }
.health-chart-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.health-chart-card { min-width: 0; padding: 12px; border: 1px solid var(--eg-border, #d8e0ec); border-radius: var(--eg-control-radius, 8px); background: var(--eg-surface, #fff); }
.health-chart-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.health-chart-title h6 { margin: 0 0 3px; font-size: 13px; }
.health-chart-title span { color: var(--eg-muted, #58677e); font-size: 10px; overflow-wrap: anywhere; }
.health-chart-latest { flex: 0 0 auto; color: var(--eg-blue, #2863e6); font-size: 13px; font-variant-numeric: tabular-nums; }
.health-chart { display: block; width: 100%; height: 190px; margin-top: 9px; overflow: visible; }
.health-gridline { stroke: var(--eg-border, #d8e0ec); stroke-width: 1; }
.health-line { fill: none; stroke: var(--eg-blue, #2863e6); stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
.health-point { fill: var(--eg-blue, #2863e6); stroke: var(--eg-surface, #fff); stroke-width: 1.5; }
.health-range-bar { stroke: var(--eg-blue, #2863e6); stroke-width: 2; opacity: .5; }
.health-event-marker { stroke: var(--eg-warning, #d98400); stroke-width: 1.2; stroke-dasharray: 4 4; opacity: .8; }
.health-failure-marker { stroke: var(--eg-danger, #b42318); stroke-width: 1.2; stroke-dasharray: 2 4; opacity: .8; }
.health-axis-label { fill: var(--eg-muted, #58677e); font-size: 9px; }
.health-chart-stats { display: flex; flex-wrap: wrap; gap: 6px 15px; color: var(--eg-muted, #58677e); font-size: 10px; }
.health-chart-stats b { color: var(--eg-text, #111827); font-variant-numeric: tabular-nums; }
.health-marker-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--eg-muted, #58677e); font-size: 10px; }
.health-marker-legend span { display: inline-flex; align-items: center; gap: 5px; }
.health-marker-legend i { display: inline-block; width: 16px; height: 0; border-top: 2px dashed var(--eg-warning, #d98400); }
.health-marker-legend .failure-key { border-color: var(--eg-danger, #b42318); border-top-style: dotted; }
.health-counter-row { display: grid; grid-template-columns: minmax(120px, .5fr) minmax(0, 2fr); gap: 8px; padding: 9px 0; border-bottom: 1px solid var(--eg-border, #d8e0ec); font-size: 11px; }
.health-counter-session { display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--eg-muted, #58677e); }
.health-counter-session code { color: var(--eg-text, #111827); overflow-wrap: anywhere; }
.health-events small { color: var(--eg-muted, #58677e); font-size: 10px; line-height: 1.4; }
@media (max-width: 720px) { .firmware-health-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) { .firmware-summary-grid, .health-home-summary, .health-chart-grid { grid-template-columns: 1fr; } .health-history-actions { width: 100%; justify-content: flex-start; } .health-chart { height: 170px; } }
@media (max-width: 420px) { .firmware-health-grid, .firmware-memory-grid, .firmware-connectivity-grid, .health-counter-row { grid-template-columns: 1fr; } .firmware-diagnostics { padding: 13px; } .health-range-control button, .health-mode-control button { padding: 6px 8px; } }
</style>
