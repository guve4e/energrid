<script setup lang="ts">
import { authFetch } from '../../auth/auth-client';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

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
  };
  events: FirmwareEvent[];
  restartCount10m: number;
  connectivity: 'connected' | 'disconnected';
};

const props = defineProps<{ deviceId: string; apiBase: string; accessToken: string }>();
const data = ref<FirmwareView | null>(null);
const available = ref(false);
const loading = ref(false);
const error = ref('');
let timer: ReturnType<typeof setInterval> | undefined;
let controller: AbortController | undefined;

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
  <section class="firmware-diagnostics" aria-label="Firmware diagnostics">
    <div class="firmware-diagnostics-heading">
      <div>
        <span class="firmware-diagnostics-eyebrow">Device health</span>
        <h4>Firmware diagnostics</h4>
      </div>
      <button type="button" class="ghost" :disabled="loading" @click="load">{{ loading ? 'Checking…' : 'Refresh' }}</button>
    </div>
    <p v-if="error" class="firmware-diagnostics-error" role="alert">{{ error }}</p>
    <p v-else-if="!available && !loading" class="firmware-diagnostics-empty">
      No diagnostic snapshot is available. This requires firmware with the read-only diagnostics endpoint; connectivity and measurement freshness are reported separately.
    </p>
    <template v-else-if="data">
      <div class="firmware-diagnostics-grid">
        <div><span>Uptime</span><strong>{{ duration(data.current.uptimeMs) }}</strong></div>
        <div><span>Last reset</span><strong>{{ data.current.reset.reason || 'Unknown' }}</strong></div>
        <div><span>Firmware</span><strong>{{ data.current.firmwareVersion }}</strong></div>
        <div><span>Boot session</span><code>{{ data.current.bootSessionId }}</code></div>
        <div><span>Heap</span><strong>{{ data.current.memory.freeHeapBytes === null ? 'Unavailable' : `${data.current.memory.freeHeapBytes} bytes` }}</strong></div>
        <div><span>Fragmentation</span><strong>{{ data.current.memory.heapFragmentationPct === null ? 'Unavailable' : `${data.current.memory.heapFragmentationPct}%` }}</strong></div>
        <div><span>Wi-Fi</span><strong>{{ data.current.wifi.connected ? `Connected${data.current.wifi.rssiDbm === null ? '' : ` · ${data.current.wifi.rssiDbm} dBm`}` : 'Disconnected' }}</strong></div>
        <div><span>Wi-Fi drops / reconnects</span><strong>{{ data.current.wifi.disconnectCount }} / {{ data.current.wifi.reconnectCount }}</strong></div>
        <div><span>Restarts observed in 10 min</span><strong>{{ data.restartCount10m }}</strong></div>
        <div><span>Connectivity</span><strong>{{ data.connectivity }}</strong></div>
      </div>
      <p class="firmware-diagnostics-sampled">Diagnostics sampled {{ timestamp(data.sampledAt) }}. Reset causes are device-reported evidence; they do not establish an unsupported underlying cause.</p>
      <ul v-if="data.events.length" class="firmware-diagnostics-events">
        <li v-for="event in [...data.events].reverse().slice(0, 8)" :key="event.id">
          <div><strong>{{ event.summary }}</strong><span>{{ timestamp(event.observedAt) }} · {{ event.confidence }}</span></div>
          <p>{{ event.explanation }}</p>
        </li>
      </ul>
      <p v-else class="firmware-diagnostics-empty">No diagnostic findings recorded.</p>
    </template>
  </section>
</template>

<style scoped>
.firmware-diagnostics { border: 1px solid var(--border, #d5dfed); border-radius: 14px; padding: 16px; background: var(--surface, #fff); }
.firmware-diagnostics-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.firmware-diagnostics-heading h4 { margin: 3px 0 0; }
.firmware-diagnostics-eyebrow { color: var(--muted, #64748b); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.firmware-diagnostics-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
.firmware-diagnostics-grid > div { min-width: 0; display: grid; gap: 4px; }
.firmware-diagnostics-grid span, .firmware-diagnostics-sampled, .firmware-diagnostics-events li > div span { color: var(--muted, #64748b); font-size: 12px; }
.firmware-diagnostics-grid strong, .firmware-diagnostics-grid code { overflow-wrap: anywhere; font-size: 13px; }
.firmware-diagnostics-events { display: grid; gap: 8px; margin: 14px 0 0; padding: 0; list-style: none; }
.firmware-diagnostics-events li { border-top: 1px solid var(--border, #d5dfed); padding-top: 9px; }
.firmware-diagnostics-events li > div { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 10px; }
.firmware-diagnostics-events p, .firmware-diagnostics-empty, .firmware-diagnostics-error { margin: 6px 0 0; font-size: 13px; line-height: 1.45; }
.firmware-diagnostics-error { color: #b42318; }
.firmware-diagnostics-sampled { margin: 12px 0 0; }
@media (max-width: 560px) { .firmware-diagnostics-grid { grid-template-columns: 1fr; } }
</style>
