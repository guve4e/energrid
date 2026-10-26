<script setup lang="ts">
import { authFetch } from '../../auth/auth-client';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

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

const props = defineProps<{ deviceId: string; apiBase: string; accessToken: string }>();
const data = ref<FirmwareView | null>(null);
const available = ref(false);
const loading = ref(false);
const error = ref('');
let timer: ReturnType<typeof setInterval> | undefined;
let controller: AbortController | undefined;
const healthLabel = computed(() => {
  if (!data.value) return 'Unavailable';
  if (!data.value.current) return 'No successful snapshot yet';
  if (data.value.collectionStatus === 'failed') return 'Latest collection failed';
  if (data.value.events.some(event => event.confidence === 'confirmed')) return 'Findings recorded';
  if (data.value.events.length) return 'Review possible findings';
  return 'No findings recorded';
});
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

function observerEvidence(failure: FirmwareView['collectionFailures'][number]): string {
  const context = failure.context;
  if (!context) return 'Observer and target context were not recorded for this historical failure.';
  const scopes = context.observer.localScopes.map(scope => `${scope.interfaceName} ${scope.cidr}`).join(', ') || 'local scope unavailable';
  return `Observer ${context.observer.host} (${context.observer.platform}; ${scopes}) could not complete a collection request to ${context.target.endpoint} in ${context.target.networkScopeName || context.target.networkScopeId || 'unknown scope'}.`;
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

watch(() => [props.deviceId, props.apiBase, props.accessToken], () => void load());
onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 60_000);
});
onBeforeUnmount(() => {
  controller?.abort();
  if (timer) clearInterval(timer);
});
</script>

<template>
  <section class="firmware-diagnostics" aria-label="Firmware diagnostics" aria-live="polite">
    <div class="firmware-diagnostics-heading">
      <div>
        <span class="firmware-diagnostics-eyebrow">Device diagnostics</span>
        <h4>Firmware health</h4>
      </div>
      <div class="firmware-diagnostics-actions">
        <span v-if="data" class="firmware-health-pill" :class="healthTone">{{ healthLabel }}</span>
        <button type="button" class="ghost" :disabled="loading" @click="load">{{ loading ? 'Checking…' : 'Refresh' }}</button>
      </div>
    </div>
    <p v-if="error" class="firmware-diagnostics-error" role="alert">{{ error }}</p>
    <p v-if="!error && data?.collectionStatus === 'failed' && data.current" class="firmware-diagnostics-note" role="status">
      The latest collection failed from the Energrid observer. The last successful device snapshot is retained below; this collector failure does not establish that the ESP lost power or Wi-Fi.
    </p>
    <p v-if="!error && loading && !data" class="firmware-diagnostics-empty" role="status">Loading firmware diagnostics…</p>
    <p v-if="!error && !available && !loading" class="firmware-diagnostics-empty">
      No diagnostic snapshot is available. This requires firmware with the read-only diagnostics endpoint; connectivity and measurement freshness are reported separately.
    </p>
    <template v-if="!error && data && !data.current">
      <p class="firmware-diagnostics-note">No successful firmware snapshot has been collected yet. A failed HTTP attempt does not establish device power or Wi-Fi state.</p>
      <ul v-if="data.collectionFailures.length" class="firmware-diagnostics-events" aria-label="Recent collection failures">
        <li v-for="failure in [...data.collectionFailures].reverse().slice(0, 8)" :key="failure.id">
          <strong>Diagnostic collection failed · {{ failure.reason }}</strong>
          <p>{{ observerEvidence(failure) }}</p>
          <time :datetime="failure.attemptedAt">{{ timestamp(failure.attemptedAt) }}</time>
        </li>
      </ul>
    </template>
    <template v-else-if="!error && data && data.current">
      <section class="firmware-diagnostics-section" aria-labelledby="firmware-health-heading">
        <div class="firmware-section-heading">
          <h5 id="firmware-health-heading">Device health</h5>
          <span>Firmware-reported snapshot</span>
        </div>
        <div class="firmware-health-grid">
          <article class="firmware-metric-card"><span>Uptime</span><strong>{{ duration(data.current.uptimeMs) }}</strong></article>
          <article class="firmware-metric-card"><span>Firmware</span><strong>{{ data.current.firmwareVersion || 'Unknown' }}</strong></article>
          <article class="firmware-metric-card"><span>Last reset</span><strong>{{ data.current.reset.reason || 'Unknown' }}</strong><small>Code {{ data.current.reset.reasonCode ?? 'unknown' }}</small></article>
          <article class="firmware-metric-card"><span>Restarts · last 10 min</span><strong>{{ data.restartCount10m }}</strong></article>
        </div>
      </section>

      <section class="firmware-diagnostics-section" aria-labelledby="firmware-memory-heading">
        <div class="firmware-section-heading"><h5 id="firmware-memory-heading">Memory</h5></div>
        <div class="firmware-health-grid firmware-memory-grid">
          <article class="firmware-metric-card"><span>Free heap</span><strong>{{ data.current.memory.freeHeapBytes === null ? 'Unavailable' : `${data.current.memory.freeHeapBytes.toLocaleString()} bytes` }}</strong></article>
          <article class="firmware-metric-card"><span>Fragmentation</span><strong>{{ data.current.memory.heapFragmentationPct === null ? 'Unavailable' : `${data.current.memory.heapFragmentationPct}%` }}</strong></article>
          <article class="firmware-metric-card"><span>Largest free block</span><strong>{{ data.current.memory.largestFreeBlockBytes === null ? 'Unavailable' : `${data.current.memory.largestFreeBlockBytes.toLocaleString()} bytes` }}</strong></article>
        </div>
      </section>

      <section class="firmware-diagnostics-section" aria-labelledby="firmware-connectivity-heading">
        <div class="firmware-section-heading">
          <h5 id="firmware-connectivity-heading">Connectivity</h5>
          <span class="firmware-health-pill" :class="data.current.wifi.connected ? 'is-healthy' : 'is-warning'">Wi-Fi {{ data.current.wifi.connected ? 'connected' : 'disconnected' }}</span>
        </div>
        <div class="firmware-health-grid firmware-connectivity-grid">
          <article class="firmware-metric-card"><span>Signal strength</span><strong>{{ data.current.wifi.rssiDbm === null ? 'Unavailable' : `${data.current.wifi.rssiDbm} dBm` }}</strong></article>
          <article class="firmware-metric-card"><span>Disconnects / reconnects</span><strong>{{ data.current.wifi.disconnectCount }} / {{ data.current.wifi.reconnectCount }}</strong></article>
          <article class="firmware-metric-card"><span>Device reachability</span><strong>{{ data.connectivity }}</strong><small>Reported separately from sensor freshness</small></article>
        </div>
      </section>

      <section class="firmware-diagnostics-section" aria-labelledby="firmware-sensor-heading">
        <div class="firmware-section-heading"><h5 id="firmware-sensor-heading">Sensor diagnostics</h5></div>
        <div class="firmware-health-grid firmware-memory-grid">
          <article class="firmware-metric-card"><span>Firmware sample count</span><strong>{{ data.current.sensor?.sampleCount?.toLocaleString() ?? 'Unavailable' }}</strong></article>
          <article class="firmware-metric-card"><span>Sensor read failures</span><strong>{{ data.current.sensor?.readFailureCount?.toLocaleString() ?? 'Unavailable' }}</strong></article>
        </div>
      </section>

      <details class="firmware-technical-details">
        <summary>Boot session and reset evidence</summary>
        <dl class="firmware-technical-grid">
          <div><dt>Boot session</dt><dd><code>{{ data.current.bootSessionId }}</code></dd></div>
          <div><dt>Sampled</dt><dd>{{ timestamp(data.sampledAt) }}</dd></div>
        </dl>
        <p class="firmware-diagnostics-note">Reset causes are device-reported evidence. They do not establish an unsupported underlying cause.</p>
      </details>

      <section class="firmware-diagnostics-section" aria-labelledby="firmware-events-heading">
        <div class="firmware-section-heading">
          <h5 id="firmware-events-heading">Diagnostic history</h5>
          <span>{{ data.snapshots?.length ?? 0 }} snapshots · {{ data.events.length }} findings · {{ data.collectionFailures?.length ?? 0 }} collection failures</span>
        </div>
        <ul v-if="data.events.length" class="firmware-diagnostics-events" aria-label="Recent diagnostic events">
          <li v-for="event in [...data.events].reverse().slice(0, 8)" :key="event.id">
            <div class="firmware-event-heading">
              <strong>{{ event.summary }}</strong>
              <span class="firmware-evidence-pill" :class="event.confidence === 'confirmed' ? 'is-confirmed' : 'is-possible'">{{ event.confidence === 'confirmed' ? 'Confirmed evidence' : 'Possible cause' }}</span>
            </div>
            <p>{{ event.explanation }}</p>
            <time :datetime="event.observedAt">{{ timestamp(event.observedAt) }}</time>
          </li>
        </ul>
        <p v-else class="firmware-diagnostics-empty">No diagnostic events recorded.</p>
        <ul v-if="data.collectionFailures?.length" class="firmware-diagnostics-events" aria-label="Recent collection failures">
          <li v-for="failure in [...data.collectionFailures].reverse().slice(0, 8)" :key="failure.id">
            <strong>Diagnostic collection failed · {{ failure.reason }}</strong>
            <p>{{ observerEvidence(failure) }}</p>
            <time :datetime="failure.attemptedAt">{{ timestamp(failure.attemptedAt) }}</time>
          </li>
        </ul>
      </section>

      <p class="firmware-diagnostics-sampled">Last successful snapshot {{ timestamp(data.lastSuccessfulContactAt || data.sampledAt) }}; last attempt {{ timestamp(data.lastAttemptAt || data.sampledAt) }}. The firmware reports no wall-clock sample time, so this is the server collection time.</p>
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
@media (max-width: 720px) { .firmware-health-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 420px) { .firmware-health-grid, .firmware-memory-grid, .firmware-connectivity-grid { grid-template-columns: 1fr; } .firmware-diagnostics { padding: 13px; } }
</style>
