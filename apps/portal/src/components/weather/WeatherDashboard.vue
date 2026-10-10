<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import ForecastDayDetail from './ForecastDayDetail.vue';
import type { ForecastDay as WeatherDay, ForecastDayDetails } from './forecast-types';

const props = defineProps<{ apiBase: string; accessToken: string }>();
interface Source { model: string; fetchedAt: string; severity: string; dataQuality: { status: string; reasons: string[] } }
interface Dashboard {
  location: string; fetchedAt: string; summary: string;
  current: { temperature: number | null; windKmh: number | null; gustKmh: number | null };
  intelligence: { headline: string; severity: string; confidence: string; rain?: RainAssessment };
  daily?: WeatherDay[];
  dayDetails?: ForecastDayDetails[];
  dailyOutlook?: { agreementDays: number; disagreementDays: number; singleModelDays: number; sourceModels: string[] };
  comparison: { status: string; selectedModel: string; selectionReason?: string; disagreementReasons?: string[]; sources: Source[] };
  dataQuality: { status: string };
}
interface RainAssessment {
  duration: string; headline: string; summary: string; totalMm: number; litersPerSquareMeter: number;
  maxHourlyMm: number; maxRainChance: number; wetHours: number; assessedHours: number;
  startsAt: string | null; endsAt: string | null;
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
const selectedDate = ref<string | null>(null);
const selectedDay = computed(() => {
  const days = dashboard.value?.daily?.slice(0, 10) ?? [];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: dashboard.value?.dayDetails?.[0]?.timezone || 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return days.find(day => day.date === selectedDate.value) ?? days.find(day => day.date === today) ?? days[0];
});
const selectedDetail = computed(() => dashboard.value?.dayDetails?.find(detail => detail.date === selectedDay.value?.date));
const weather = ref<{ status: string; summary: WeatherScore[]; pending?: { scheduled: number; awaitingObservations: number }; note?: string } | null>(null);
const river = ref<{ status?: string; summary: RiverScore[]; note?: string } | null>(null);
const errors = ref<Record<string, string>>({});
const loading = ref(false);
const lastRefresh = ref<string | null>(null);
let controller: AbortController | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let disposed = false;
const names: Record<string,string> = { icon_seamless: 'DWD ICON', ncep_gfs_seamless: 'NOAA GFS', 'selected-cautious': 'Selected forecast' };
const modelName = (value: string) => {
  const model = value.split(':').at(-1) || value;
  return names[model] || model;
};
const number = (value: number | null | undefined, digits = 1) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(digits);
const time = (value: string | null) => value ? new Date(value).toLocaleString() : '—';
const hour = (value: string | null | undefined) => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
const label = (value: string) => value.replaceAll('-', ' ').replaceAll('_', ' ');
const metric = (value: string) => ({ temperature_c: 'Temperature · °C', gust_kmh: 'Hourly gust · km/h', precipitation_mm: 'Hourly rain · mm', rain_probability: 'Rain probability' })[value] || value;
const dayLabel = (value: string) => value ? new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${value}T12:00:00`)) : '—';
const iconFor = (code: number | null | undefined) => {
  if ([95, 96, 99].includes(code ?? -1)) return '⛈';
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code ?? -1)) return '☔';
  if ([71, 73, 75, 77, 85, 86].includes(code ?? -1)) return '❄';
  if ([45, 48].includes(code ?? -1)) return '≋';
  if ([2, 3].includes(code ?? -1)) return '☁';
  if ([0, 1].includes(code ?? -1)) return '☀';
  return '◌';
};
const dailyOutlookLabel = (days: WeatherDay[] = []) => {
  const disagreements = days.filter((day) => day.agreement === 'disagreement').length;
  const singleModel = days.filter((day) => day.agreement === 'single-model').length;
  if (disagreements) return `${disagreements} cautious day${disagreements === 1 ? '' : 's'}`;
  if (singleModel) return `${singleModel} single-model day${singleModel === 1 ? '' : 's'}`;
  return 'Models agree';
};
const dayAgreementLabel = (day: WeatherDay) =>
  day.agreement === 'disagreement' ? 'Cautious' :
    day.agreement === 'single-model' ? 'Single model' : day.agreement === 'agreement' ? 'Agreed' : 'Unverified';
const daySourceLabel = (day: WeatherDay) => day.sourceModel ? modelName(day.sourceModel) : 'Selected forecast';
const rainImpactLabel = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(Number(value))) return 'unknown rain';
  const rain = Number(value);
  if (rain <= 0) return 'no rain';
  if (rain < 1) return 'trace';
  if (rain < 5) return 'light';
  if (rain < 15) return 'meaningful';
  if (rain < 30) return 'heavy wet day';
  return 'substantial';
};
const dailyRainImpact = (value: number | null | undefined) =>
  value == null || !Number.isFinite(Number(value))
    ? '— rain'
    : `${number(value)} mm = ${number(value)} L/m²`;
async function weatherErrorMessage(response: Response) {
  if (response.status === 401) return 'Please sign in again.';
  try {
    const body = await response.json() as { message?: unknown; error?: unknown };
    const message = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : '';
    if (message) return message;
  } catch {
    // Fall through to the status-aware default below.
  }
  return response.status === 503 ? 'Weather service unavailable. Check that the core service is running.' : 'Temporarily unavailable. Please retry.';
}

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
      if (!response.ok) throw new Error(await weatherErrorMessage(response));
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
        <article><span>Selected forecast source</span><strong>{{ modelName(dashboard.comparison.selectedModel || 'Unavailable') }}</strong><small v-if="dashboard.comparison.selectionReason">{{ dashboard.comparison.selectionReason }}</small></article>
      </div>
      <section v-if="dashboard.daily?.length" class="daily-forecast" aria-labelledby="ten-day-forecast">
        <div class="section-title">
          <h3 id="ten-day-forecast">10-day forecast</h3>
          <span>{{ dailyOutlookLabel(dashboard.daily) }}</span>
        </div>
        <div class="daily-grid">
          <button v-for="day in dashboard.daily.slice(0, 10)" :key="day.date" type="button" :class="['day-card', `agreement-${day.agreement || 'unknown'}`]" :aria-pressed="selectedDay?.date === day.date" :aria-label="`Forecast for ${dayLabel(day.date)}`" aria-controls="selected-day-panel" @click="selectedDate = day.date">
            <span>{{ dayLabel(day.date) }}</span>
            <em class="day-badge">{{ dayAgreementLabel(day) }}</em>
            <strong>{{ iconFor(day.weatherCode) }}</strong>
            <span class="day-condition">{{ day.condition }}</span>
            <b>{{ number(day.tempMax) }}° / {{ number(day.tempMin) }}°</b>
            <small>{{ dailyRainImpact(day.rainTotalMm) }}</small>
            <small>{{ rainImpactLabel(day.rainTotalMm) }} · {{ number(day.rainChanceMax, 0) }}% rain</small>
            <small>{{ number(day.gustMaxKmh, 0) }} km/h gust</small>
            <small>{{ daySourceLabel(day) }}</small>
          </button>
        </div>
        <ForecastDayDetail v-if="selectedDay" id="selected-day-panel" :day="selectedDay" :detail="selectedDetail" />
      </section>
      <section v-if="dashboard.intelligence.rain" class="rain-card" aria-labelledby="rain-outlook">
        <div>
          <p class="eyebrow">Next 24 hours · Rain intelligence</p>
          <h3 id="rain-outlook">{{ dashboard.intelligence.rain.headline }}</h3>
          <p>{{ dashboard.intelligence.rain.summary }}</p>
        </div>
        <div class="rain-grid">
          <article><span>Total</span><strong>{{ number(dashboard.intelligence.rain.totalMm) }} mm</strong><small>{{ number(dashboard.intelligence.rain.litersPerSquareMeter) }} L/m²</small></article>
          <article><span>Wet hours</span><strong>{{ dashboard.intelligence.rain.wetHours }}/{{ dashboard.intelligence.rain.assessedHours }}</strong><small>{{ label(dashboard.intelligence.rain.duration) }}</small></article>
          <article><span>Peak hour</span><strong>{{ number(dashboard.intelligence.rain.maxHourlyMm) }} mm</strong><small>{{ number(dashboard.intelligence.rain.maxRainChance, 0) }}% max chance</small></article>
          <article><span>Window</span><strong>{{ hour(dashboard.intelligence.rain.startsAt) }}</strong><small>to {{ hour(dashboard.intelligence.rain.endsAt) }}</small></article>
        </div>
      </section>
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
      <p v-else-if="river?.status === 'migration-required'" class="weather-notice">River forecast storage needs initialization before scoring can start.</p>
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
.weather-page{display:grid;gap:20px;min-width:0}.weather-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.weather-header h2{margin:4px 0 12px}.weather-header p{margin-bottom:0}.weather-muted{color:#64748b;font-size:13px;line-height:1.6;margin:0}.weather-notice{background:#edf3ff;border:1px solid #cbdaf5;border-radius:12px;padding:16px;line-height:1.5}.weather-notice.caution{background:#fff7e6;border-color:#f0d69a;color:#5d4108}.weather-notice p{margin:8px 0}.weather-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.weather-metrics article{padding:20px;border:1px solid #d8e0ec;border-radius:12px}.weather-metrics span,.weather-metrics strong,.weather-metrics small,.rain-grid span,.rain-grid strong,.rain-grid small,.day-card span,.day-card strong,.day-card b,.day-card small{display:block}.weather-metrics strong{font-size:24px;margin-top:8px}.weather-metrics small{color:#64748b;font-size:12px;line-height:1.35;margin-top:8px}.rain-card{border:1px solid #bdd3f4;background:#f8fbff;border-radius:12px;padding:18px;grid-template-columns:minmax(220px,.8fr) 1fr;align-items:start}.rain-card p{margin:0;color:#475569;line-height:1.5}.rain-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.rain-grid article{min-height:92px;padding:14px;border:1px solid #d8e0ec;border-radius:8px;background:#fff}.rain-grid span,.day-card span{color:#64748b;font-size:12px;font-weight:800;text-transform:uppercase}.rain-grid strong{font-size:22px;margin:6px 0 4px}.rain-grid small{color:#64748b;font-size:12px}.section-title{display:flex;align-items:end;justify-content:space-between;gap:12px}.section-title h3{margin:0}.section-title span{color:#64748b;font-size:12px;font-weight:800}.daily-grid{display:grid;grid-template-columns:repeat(10,minmax(112px,1fr));gap:8px;overflow-x:auto;padding-bottom:4px}.day-card{min-height:214px;padding:12px;border:1px solid #d8e0ec;border-radius:8px;background:#fff}.day-card.agreement-disagreement{border-color:#f0c36d;background:#fffaf0}.day-card strong{font-size:24px;line-height:1;margin:10px 0 8px}.day-card p{height:34px;margin:0 0 10px;color:#475569;font-size:12px;line-height:1.4;overflow:hidden}.day-card b{font-size:17px;margin-bottom:7px}.day-card small{color:#64748b;font-size:11px;line-height:1.35}.day-badge{display:inline-block;margin-top:8px;padding:3px 7px;border-radius:999px;background:#edf3ff;color:#2563eb;font-size:10px;font-style:normal;font-weight:800;text-transform:uppercase}.agreement-disagreement .day-badge{background:#fff1c7;color:#9a5b00}.agreement-single-model .day-badge{background:#f1f5f9;color:#475569}.weather-table{overflow-x:auto}.weather-table table{width:100%;border-collapse:collapse;font-size:13px}.weather-table th,.weather-table td{text-align:left;padding:14px 10px;border-bottom:1px solid #d8e0ec;vertical-align:top}.weather-table small{display:block;color:#64748b;font-size:11px;margin-top:6px;max-width:320px}.weather-page h3{margin:8px 0 12px}.weather-page section{display:grid;gap:12px}
@media(max-width:1100px){.daily-grid{grid-template-columns:repeat(10,126px)}}
.day-card{font:inherit;text-align:left;cursor:pointer;color:inherit;min-width:0;letter-spacing:0;transition:border-color .15s,box-shadow .15s}.day-card[aria-pressed=true]{border-color:#2563eb;box-shadow:inset 0 0 0 1px #2563eb}.day-card:hover{border-color:#2563eb}.day-card:focus-visible{outline:3px solid #2563eb;outline-offset:-3px}.day-card .day-condition{height:34px;margin:0 0 10px;color:#475569;font-size:12px;line-height:1.4;overflow:hidden;font-weight:400;text-transform:none}.daily-grid{padding:3px 0 8px}.day-card>span:first-child{min-height:30px}
@media(max-width:900px){.rain-card{grid-template-columns:1fr}.rain-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:700px){.weather-metrics,.rain-grid{grid-template-columns:1fr}.weather-header{flex-direction:column}.weather-metrics strong{font-size:21px}}
.theme-dark .weather-notice{background:#14223a;border-color:#31415c;color:#e2e8f0}
.theme-dark .weather-notice.caution{background:#362a15;border-color:#735727;color:#ffe5aa}
.theme-dark .weather-muted,.theme-dark .weather-table small{color:#a5b4c8}
.theme-dark .rain-card{background:#101b2e;border-color:#31415c}
.theme-dark .rain-card p,.theme-dark .rain-grid span,.theme-dark .rain-grid small,.theme-dark .section-title span,.theme-dark .day-card span,.theme-dark .day-card small,.theme-dark .day-card p{color:#a5b4c8}
.theme-dark .rain-grid article,.theme-dark .day-card{background:#111827;border-color:#31415c}
.theme-dark .day-card.agreement-disagreement{background:#2d2414;border-color:#735727}
.theme-dark .day-badge{background:#14223a;color:#93c5fd}
.theme-dark .agreement-disagreement .day-badge{background:#4a3411;color:#fde68a}
.theme-dark .agreement-single-model .day-badge{background:#1f2937;color:#cbd5e1}
.theme-dark .weather-table th,.theme-dark .weather-table td,.theme-dark .weather-metrics article{border-color:#31415c}
</style>
