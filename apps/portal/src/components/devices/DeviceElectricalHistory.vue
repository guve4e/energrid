<script setup lang="ts">
import { authFetch } from '../../auth/auth-client';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

type Metric = 'power' | 'energy_import_total' | 'energy_export_total';
type Point = { observedAt: string; value: number; unit: 'W' | 'kWh' };
type Series = { metric: Metric; unit: string; measurements: Point[] };
const props = defineProps<{ deviceId: string; apiBase: string; accessToken: string; deviceStatus: string }>();
const metricLabels: Record<Metric, string> = { power: 'Power', energy_import_total: 'Imported energy', energy_export_total: 'Exported energy' };
const rangeOptions = [
  { value: '1h', label: '1 hour', ms: 60 * 60_000 },
  { value: '24h', label: '24 hours', ms: 24 * 60 * 60_000 },
  { value: '7d', label: '7 days', ms: 7 * 24 * 60 * 60_000 },
] as const;
const range = ref<(typeof rangeOptions)[number]['value']>('24h');
const selectedRange = computed(() => rangeOptions.find(option => option.value === range.value) ?? rangeOptions[1]);
const series = ref<Partial<Record<Metric, Series>>>({});
const loading = ref(false);
const error = ref('');
let controller: AbortController | undefined;
let requestRevision = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const metrics: Metric[] = ['power', 'energy_import_total', 'energy_export_total'];
const availableSeries = computed(() => metrics.map(metric => series.value[metric]).filter((item): item is Series => !!item && item.measurements.length > 0));
const connectivity = computed(() => ['online', 'healthy', 'connected'].includes(props.deviceStatus.toLowerCase()) ? 'Connected' : ['offline', 'disconnected'].includes(props.deviceStatus.toLowerCase()) ? 'Disconnected' : 'Unknown');

async function load() {
  controller?.abort();
  const active = new AbortController();
  controller = active;
  const request = ++requestRevision;
  loading.value = true;
  error.value = '';
  series.value = {};
  const to = new Date();
  const from = new Date(to.getTime() - selectedRange.value.ms);
  try {
    const entries = await Promise.all(metrics.map(async metric => {
      const query = new URLSearchParams({ metric, from: from.toISOString(), to: to.toISOString() });
      const response = await authFetch(`${props.apiBase}/portal/devices/${encodeURIComponent(props.deviceId)}/electrical-measurements?${query}`, {
        headers: { Authorization: `Bearer ${props.accessToken}` }, signal: active.signal,
      });
      if (!response.ok) {
        if (response.status === 403) throw new Error('Electrical readings are supported but are not authorized for this device.');
        if (response.status === 404) return [metric, null] as const;
        throw new Error('Electrical measurements are unavailable.');
      }
      const result = await response.json() as { deviceId: string; metric: Metric; unit: string; measurements: Point[] };
      if (result.deviceId !== props.deviceId || result.metric !== metric || !Array.isArray(result.measurements)) throw new Error('Electrical history returned an invalid response.');
      return [metric, result] as const;
    }));
    if (request === requestRevision) series.value = Object.fromEntries(entries.filter(entry => entry[1] !== null)) as Partial<Record<Metric, Series>>;
  } catch (cause) {
    if (active.signal.aborted || request !== requestRevision) return;
    error.value = cause instanceof Error ? cause.message : 'Electrical measurements are unavailable.';
  } finally {
    if (request === requestRevision) loading.value = false;
  }
}

function valueLabel(item: Series) {
  const last = item.measurements[item.measurements.length - 1];
  if (!last) return '—';
  const age = Date.now() - Date.parse(last.observedAt);
  const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: item.metric === 'power' ? 1 : 3 }).format(last.value);
  return `${number} ${item.unit}${age > 5 * 60_000 ? ' · Stale' : ''}`;
}
function position(item: Series, point: Point) {
  const values = item.measurements.map(row => row.value);
  const min = Math.min(...values), max = Math.max(...values);
  const pad = Math.max((max - min) * 0.15, Math.abs(max || 1) * 0.02, 0.01);
  const x = 8 + ((Date.parse(point.observedAt) - (Date.now() - selectedRange.value.ms)) / selectedRange.value.ms) * 284;
  const y = 92 - ((point.value - (min - pad)) / ((max + pad) - (min - pad))) * 68;
  return { x: Math.max(8, Math.min(292, x)), y };
}
function timeLabel(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) : 'Unknown time';
}
watch(() => [props.deviceId, props.apiBase, props.accessToken, range.value], () => void load());
onMounted(() => { void load(); timer = setInterval(() => void load(), 60_000); });
onBeforeUnmount(() => { controller?.abort(); if (timer) clearInterval(timer); });
</script>

<template>
  <section class="device-electrical-history" aria-label="Authorized electrical measurements" :aria-busy="loading">
    <div class="electrical-heading"><div><span class="electrical-eyebrow">Verified power capability</span><h5>Electrical measurements</h5></div><span class="electrical-connection">{{ connectivity }}</span></div>
    <p v-if="loading && !availableSeries.length" class="electrical-muted" role="status">Loading authorized electrical readings…</p>
    <p v-else-if="error" class="electrical-error" role="alert">{{ error }}</p>
    <p v-else-if="!availableSeries.length" class="electrical-muted">Power monitoring is supported; no electrical readings have been recorded yet.</p>
    <template v-else>
      <div class="electrical-current-grid">
        <article v-for="item in availableSeries" :key="item.metric" class="electrical-current-card">
          <span>{{ metricLabels[item.metric] }}</span><strong>{{ valueLabel(item) }}</strong>
          <time>{{ timeLabel(item.measurements[item.measurements.length - 1].observedAt) }}</time>
        </article>
      </div>
      <div class="electrical-history-heading"><div><h6>History</h6><p>Stored measurements; gaps are not interpolated.</p></div><div class="electrical-ranges" role="group" aria-label="Electrical history range"><button v-for="option in rangeOptions" :key="option.value" type="button" :aria-pressed="range === option.value" @click="range = option.value">{{ option.label }}</button></div></div>
      <div class="electrical-chart-grid">
        <article v-for="item in availableSeries" :key="item.metric" class="electrical-chart-card"><header><strong>{{ metricLabels[item.metric] }}</strong><span>{{ item.unit }}</span></header>
          <svg viewBox="0 0 300 110" role="img" :aria-label="`${metricLabels[item.metric]} history`"><line x1="8" y1="94" x2="292" y2="94" class="electrical-axis" /><circle v-for="point in item.measurements" :key="`${point.observedAt}-${point.value}`" :cx="position(item, point).x" :cy="position(item, point).y" r="3" class="electrical-point"><title>{{ timeLabel(point.observedAt) }} · {{ point.value }} {{ item.unit }}</title></circle></svg>
          <div class="electrical-chart-times"><span>{{ timeLabel(new Date(Date.now() - selectedRange.ms).toISOString()) }}</span><span>{{ timeLabel(new Date().toISOString()) }}</span></div>
        </article>
      </div>
    </template>
  </section>
</template>

<style scoped>
.device-electrical-history{display:grid;gap:10px;min-width:0;color:var(--eg-text,#111827)}.electrical-heading,.electrical-history-heading,.electrical-chart-card header{display:flex;align-items:center;justify-content:space-between;gap:10px}.electrical-eyebrow,.electrical-current-card>span{color:var(--eg-muted,#58677e);font-size:11px}.electrical-heading h5,.electrical-history-heading h6{margin:2px 0 0;font-size:14px}.electrical-connection{font-size:11px;color:var(--eg-muted,#58677e)}.electrical-current-grid,.electrical-chart-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));gap:8px}.electrical-current-card,.electrical-chart-card{display:grid;gap:5px;min-width:0;padding:11px;border:1px solid var(--eg-border,#d8e0ec);border-radius:var(--eg-card-radius,12px);background:var(--eg-surface,#fff)}.electrical-current-card strong{font-size:16px}.electrical-current-card time,.electrical-history-heading p,.electrical-chart-times,.electrical-muted,.electrical-error{margin:0;color:var(--eg-muted,#58677e);font-size:11px}.electrical-history-heading p{margin-top:3px}.electrical-ranges{display:flex;gap:4px;flex-wrap:wrap}.electrical-ranges button{min-height:34px;border:1px solid var(--eg-border,#d8e0ec);border-radius:8px;padding:5px 8px;background:var(--eg-surface,#fff);color:inherit;font:inherit;font-size:10px;cursor:pointer}.electrical-ranges button[aria-pressed=true]{border-color:var(--eg-blue,#2863e6);background:var(--eg-blue-soft,#eef4ff);color:var(--eg-blue,#2863e6)}.electrical-chart-card header{font-size:11px}.electrical-chart-card header span{color:var(--eg-muted,#58677e)}.electrical-chart-card svg{width:100%;height:auto}.electrical-axis{stroke:var(--eg-border,#d8e0ec)}.electrical-point{fill:var(--eg-blue,#2863e6);stroke:var(--eg-surface,#fff);stroke-width:1.5}.electrical-chart-times{display:flex;justify-content:space-between;font-size:9px}.electrical-error{color:var(--eg-danger,#b42318)}@media(max-width:540px){.electrical-history-heading{align-items:flex-start;flex-direction:column}.electrical-ranges{width:100%}.electrical-ranges button{flex:1}}
</style>
