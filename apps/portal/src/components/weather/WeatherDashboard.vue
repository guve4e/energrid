<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

const props = defineProps<{ apiBase: string; accessToken: string }>();
interface Source { model: string; fetchedAt: string; severity: string; dataQuality: { status: string; reasons: string[] } }
interface Dashboard {
  location: string; fetchedAt: string; summary: string;
  current: { temperature: number | null; windKmh: number | null; gustKmh: number | null };
  intelligence: { headline: string; severity: string; confidence: string };
  comparison: { status: string; selectedModel: string; sources: Source[] };
  dataQuality: { status: string };
}
interface WeatherScore {
  provider?: string; modelVersion: string; metric: string; horizonHours: number; observationSource: string;
  samples: number; mae: number | null; rmse: number | null; bias: number | null;
  brierScore: number | null; skillVsPersistence: number | null;
}
interface RiverScore {
  modelVersion: string; horizonHours: number; samples: number; maeCm: number | null;
  rmseCm: number | null; biasCm: number | null; rangeHitPct: number | null;
  directionAccuracyPct: number | null; verificationVersion: string; observationTimeBasis: string;
}
const dashboard = ref<Dashboard | null>(null);
const weather = ref<{ status: string; summary: WeatherScore[]; pending?: { scheduled: number; awaitingObservations: number }; note?: string } | null>(null);
const river = ref<{ summary: RiverScore[]; note?: string } | null>(null);
const errors = ref<Record<string, string>>({});
const loading = ref(false);
const lastRefresh = ref<string | null>(null);
let controller: AbortController | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let disposed = false;
const names: Record<string,string> = { icon_seamless: 'DWD ICON', ncep_gfs_seamless: 'NOAA GFS', 'selected-cautious': 'Selected forecast' };
const modelName = (value: string) => names[value.split(':')[0]] || value;
const number = (value: number | null | undefined, digits = 1) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(digits);
const time = (value: string | null) => value ? new Date(value).toLocaleString() : '—';
const label = (value: string) => value.replaceAll('-', ' ').replaceAll('_', ' ');
const metric = (value: string) => ({ temperature_c: 'Temperature · °C', gust_kmh: 'Hourly gust · km/h', precipitation_mm: 'Hourly rain · mm', rain_probability: 'Rain probability' })[value] || value;

async function refresh() {
  if (loading.value) return;
  loading.value = true;
  controller = new AbortController();
  const timeout = setTimeout(() => controller?.abort(), 25000);
  try {
    const results = await Promise.allSettled(['dashboard','performance','river-performance'].map(async endpoint => {
      const response = await fetch(`${props.apiBase}/portal/weather/${endpoint}`, {
        headers: { Authorization: `Bearer ${props.accessToken}` }, signal: controller!.signal,
      });
      if (!response.ok) throw new Error(response.status === 401 ? 'Please sign in again.' : 'Temporarily unavailable. Please retry.');
      return response.json();
    }));
    if (disposed) return;
    const nextErrors: Record<string,string> = {};
    results.forEach((result, i) => { if (result.status === 'rejected') nextErrors[String(i)] = String(result.reason?.message || result.reason); });
    // Clear failed results: old forecasts must not retain the appearance of current data.
    dashboard.value = results[0].status === 'fulfilled' ? results[0].value : null;
    weather.value = results[1].status === 'fulfilled' ? results[1].value : null;
    river.value = results[2].status === 'fulfilled' ? results[2].value : null;
    errors.value = nextErrors;
    lastRefresh.value = new Date().toISOString();
  } finally { clearTimeout(timeout); loading.value = false; }
}
onMounted(() => { void refresh(); timer = setInterval(() => { void refresh(); }, 5 * 60000); });
onBeforeUnmount(() => { disposed = true; controller?.abort(); if (timer) clearInterval(timer); });
</script>

<template>
  <section class="panel workspace-panel weather-page" aria-label="Weather and forecast accuracy">
    <header class="weather-header">
      <div><p class="eyebrow">Weather intelligence</p><h2>Forecasts, checked against reality</h2>
        <p>Vidin · Compare the models today. Measure their results as observations arrive.</p></div>
      <button type="button" :disabled="loading" @click="refresh">{{ loading ? 'Refreshing…' : 'Refresh' }}</button>
    </header>
    <p class="weather-muted">Last refresh attempt: {{ time(lastRefresh) }} · Automatic device actions are disabled.</p>

    <p v-if="errors['0']" class="weather-notice" role="alert">Current forecast: {{ errors['0'] }}</p>
    <p v-else-if="!dashboard && loading" role="status">Loading forecast sources…</p>
    <template v-if="dashboard">
      <div :class="['weather-notice', { caution: dashboard.dataQuality.status !== 'available' || dashboard.comparison.status !== 'agreement' }]">
        <strong>{{ dashboard.intelligence.headline }}</strong><p>{{ dashboard.summary }}</p>
        <span>Data: {{ label(dashboard.dataQuality.status) }} · Models: {{ label(dashboard.comparison.status) }}</span>
      </div>
      <div class="weather-metrics">
        <article><span>Temperature</span><strong>{{ number(dashboard.current.temperature) }} °C</strong></article>
        <article><span>Wind gust</span><strong>{{ number(dashboard.current.gustKmh) }} km/h</strong></article>
        <article><span>Selected forecast</span><strong>{{ modelName(dashboard.comparison.selectedModel || 'Unavailable') }}</strong></article>
      </div>
      <h3>Forecast sources</h3>
      <p class="weather-muted">Both models use Open-Meteo delivery. Agreement does not establish measured accuracy.</p>
      <div class="weather-table"><table><thead><tr><th>Model</th><th>Availability</th><th>Risk</th><th>Fetched</th></tr></thead>
        <tbody><tr v-for="source in dashboard.comparison.sources" :key="source.model">
          <td>{{ modelName(source.model) }}</td><td>{{ label(source.dataQuality.status) }}<small v-if="source.dataQuality.reasons.length">{{ source.dataQuality.reasons.map(label).join(', ') }}</small></td>
          <td>{{ source.severity }}</td><td>{{ time(source.fetchedAt) }}</td>
        </tr></tbody></table></div>
    </template>

    <section aria-labelledby="weather-accuracy"><h3 id="weather-accuracy">Measured weather accuracy · last 90 days</h3>
      <p v-if="errors['1']" class="weather-notice" role="alert">{{ errors['1'] }}</p>
      <p v-else-if="weather?.status === 'migration-required'" class="weather-notice">Forecast storage needs initialization before recording can start.</p>
      <template v-else-if="weather">
        <p v-if="!weather.summary.length" class="weather-notice">Awaiting measured observations. No accuracy score is available yet.</p>
        <p v-if="weather.pending" class="weather-muted">{{ weather.pending.scheduled }} future predictions · {{ weather.pending.awaitingObservations }} predictions awaiting observations</p>
        <p class="weather-muted">Average error and RMSE: lower is better. Bias = observation − prediction. Rain probability uses Brier score (0 is best). Positive skill beats “conditions stay unchanged.”</p>
        <div v-if="weather.summary.length" class="weather-table"><table><thead><tr><th>Model / measurement</th><th>Lead window</th><th>Samples</th><th>Average error</th><th>RMSE</th><th>Bias</th><th>Brier</th><th>Skill</th></tr></thead>
          <tbody><tr v-for="row in weather.summary" :key="`${row.provider}-${row.modelVersion}-${row.metric}-${row.horizonHours}-${row.observationSource}`">
            <td>{{ modelName(row.modelVersion) }}<small>{{ metric(row.metric) }} · {{ row.observationSource }}</small></td><td>{{ row.horizonHours - 1 }}–{{ row.horizonHours }} h</td>
            <td>{{ row.samples }}<small v-if="row.samples < 30">Limited evidence</small></td>
            <td>{{ row.metric === 'rain_probability' ? '—' : number(row.mae) }}</td><td>{{ row.metric === 'rain_probability' ? '—' : number(row.rmse) }}</td>
            <td>{{ row.metric === 'rain_probability' ? '—' : number(row.bias) }}</td><td>{{ number(row.brierScore, 3) }}</td>
            <td>{{ row.skillVsPersistence == null ? '—' : number(row.skillVsPersistence * 100) + '%' }}</td>
          </tr></tbody></table></div>
      </template>
    </section>

    <section aria-labelledby="river-accuracy"><h3 id="river-accuracy">River forecast accuracy · Vidin · last 90 days</h3>
      <p v-if="errors['2']" class="weather-notice" role="alert">{{ errors['2'] }}</p>
      <template v-else-if="river">
        <p class="weather-notice">River scores are provisional: provider timestamps may represent fetch time. Legacy results are kept separate.</p>
        <p v-if="!river.summary.length" class="weather-muted">No evaluated river predictions yet. New predictions are recorded for 6 and 24 hours ahead.</p>
        <div v-else class="weather-table"><table><thead><tr><th>Model / scoring</th><th>Lead</th><th>Samples</th><th>Average error</th><th>RMSE</th><th>Bias</th><th>Range hits</th><th>Direction</th></tr></thead>
          <tbody><tr v-for="(row,index) in river.summary" :key="index">
            <td>{{ row.modelVersion }}<small>{{ row.verificationVersion }} · {{ label(row.observationTimeBasis || 'unknown') }}</small></td>
            <td>{{ row.horizonHours }} h</td><td>{{ row.samples }}<small v-if="row.samples < 30">Limited evidence</small></td>
            <td>{{ number(row.maeCm) }} cm</td><td>{{ number(row.rmseCm) }} cm</td><td>{{ number(row.biasCm) }} cm</td>
            <td>{{ number(row.rangeHitPct) }}%</td><td>{{ number(row.directionAccuracyPct) }}%</td>
          </tr></tbody></table></div>
      </template>
    </section>
  </section>
</template>

<style scoped>
.weather-page{display:grid;gap:20px;min-width:0}.weather-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.weather-header h2{margin:4px 0 12px}.weather-header p{margin-bottom:0}.weather-muted{color:#64748b;font-size:13px;line-height:1.6;margin:0}.weather-notice{background:#edf3ff;border:1px solid #cbdaf5;border-radius:12px;padding:16px;line-height:1.5}.weather-notice.caution{background:#fff7e6;border-color:#f0d69a;color:#5d4108}.weather-notice p{margin:8px 0}.weather-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.weather-metrics article{padding:20px;border:1px solid #d8e0ec;border-radius:12px}.weather-metrics span,.weather-metrics strong{display:block}.weather-metrics strong{font-size:24px;margin-top:8px}.weather-table{overflow-x:auto}.weather-table table{width:100%;border-collapse:collapse;font-size:13px}.weather-table th,.weather-table td{text-align:left;padding:14px 10px;border-bottom:1px solid #d8e0ec;vertical-align:top}.weather-table small{display:block;color:#64748b;font-size:11px;margin-top:6px;max-width:320px}.weather-page h3{margin:8px 0 12px}.weather-page section{display:grid;gap:12px}
@media(max-width:700px){.weather-metrics{grid-template-columns:1fr}.weather-header{flex-direction:column}.weather-metrics strong{font-size:21px}}
:global(.theme-dark) .weather-notice{background:#14223a;border-color:#31415c;color:#e2e8f0}
:global(.theme-dark) .weather-notice.caution{background:#362a15;border-color:#735727;color:#ffe5aa}
:global(.theme-dark) .weather-muted,:global(.theme-dark) .weather-table small{color:#a5b4c8}
:global(.theme-dark) .weather-table th,:global(.theme-dark) .weather-table td,:global(.theme-dark) .weather-metrics article{border-color:#31415c}
</style>
