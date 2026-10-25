<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { authFetch } from '../../auth/auth-client';

const props = defineProps<{ apiBase: string; accessToken: string }>();

type ForecastDay = {
  date: string;
  condition?: string;
  weatherCode?: number | null;
  tempMax?: number | null;
  tempMin?: number | null;
  rainChanceMax?: number | null;
};

type Weather = {
  location: string;
  fetchedAt: string;
  current: { temperature: number | null; windKmh: number | null; gustKmh: number | null };
  intelligence?: { headline?: string };
  daily?: ForecastDay[];
  dataQuality?: { status: string };
};

const weather = ref<Weather | null>(null);
const error = ref('');
const loading = ref(true);
let controller: AbortController | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

function format(value: number | null | undefined, digits = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function weatherIcon(code?: number | null) {
  if ([95, 96, 99].includes(code ?? -1)) return '⛈';
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code ?? -1)) return '☂';
  if ([71, 73, 75, 77, 85, 86].includes(code ?? -1)) return '❄';
  if ([2, 3, 45, 48].includes(code ?? -1)) return '☁';
  if ([0, 1].includes(code ?? -1)) return '☀';
  return '◌';
}

function dayLabel(date: string) {
  return new Intl.DateTimeFormat('bg-BG', { weekday: 'short', timeZone: 'UTC' })
    .format(new Date(`${date}T12:00:00Z`));
}

const fresh = computed(() => {
  if (!weather.value?.fetchedAt) return false;
  const age = Date.now() - Date.parse(weather.value.fetchedAt);
  return Number.isFinite(age) && age >= 0 && age < 3 * 3600000 && weather.value.dataQuality?.status === 'available';
});

async function loadWeather() {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  loading.value = true;
  try {
    const response = await authFetch(`${props.apiBase}/portal/weather/dashboard`, {
      headers: { Authorization: `Bearer ${props.accessToken}` },
      signal: current.signal,
    });
    if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again to view weather.' : `Weather service unavailable (${response.status}).`);
    const result = await response.json() as Weather;
    if (controller !== current) return;
    weather.value = result;
    error.value = '';
  } catch (cause) {
    if (current.signal.aborted) return;
    weather.value = null;
    error.value = cause instanceof Error ? cause.message : 'Weather service unavailable.';
  } finally {
    if (controller === current) loading.value = false;
  }
}

onMounted(() => {
  void loadWeather();
  timer = setInterval(() => void loadWeather(), 5 * 60000);
});

onBeforeUnmount(() => {
  controller?.abort();
  if (timer) clearInterval(timer);
});
</script>

<template>
  <section class="home-weather-card" aria-label="Weather">
    <header class="home-weather-header">
      <div>
        <p class="eyebrow">WEATHER</p>
        <h2>{{ weather?.location || 'Weather' }}</h2>
      </div>
      <span :class="['home-weather-status', { unavailable: !fresh }]">{{ fresh ? 'CURRENT' : 'UNAVAILABLE' }}</span>
    </header>

    <p v-if="loading && !weather" class="home-weather-message">Loading weather…</p>
    <p v-else-if="error" class="home-weather-message" role="status">{{ error }}</p>
    <p v-else-if="!fresh" class="home-weather-message" role="status">Weather data is unavailable or stale.</p>

    <template v-if="weather && fresh">
      <div class="home-weather-current">
        <span class="home-weather-icon" aria-hidden="true">{{ weatherIcon(weather.daily?.[0]?.weatherCode) }}</span>
        <strong>{{ format(weather.current.temperature) }}<small>°C</small></strong>
        <p>{{ weather.intelligence?.headline || 'Current conditions' }}</p>
      </div>
      <div class="home-weather-meta">
        <span>Wind {{ format(weather.current.windKmh) }} km/h</span>
        <span>Gusts {{ format(weather.current.gustKmh) }} km/h</span>
      </div>
      <div class="home-weather-forecast">
        <article v-for="day in weather.daily?.slice(0, 3)" :key="day.date">
          <span>{{ dayLabel(day.date) }}</span>
          <strong aria-hidden="true">{{ weatherIcon(day.weatherCode) }}</strong>
          <b>{{ format(day.tempMax) }}° / {{ format(day.tempMin) }}°</b>
          <small>{{ day.condition || 'Forecast' }} · {{ format(day.rainChanceMax) }}% rain</small>
        </article>
      </div>
    </template>
  </section>
</template>

<style scoped>
.home-weather-card { min-width: 0; padding: 22px; border: 1px solid var(--home-border); border-radius: 18px; background: linear-gradient(145deg, var(--home-surface), var(--home-surface-soft)); color: var(--home-text); }
.home-weather-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.home-weather-header .eyebrow { margin: 0; color: var(--home-accent); font-size: 10px; font-weight: 800; letter-spacing: .14em; }
.home-weather-header h2 { margin: 6px 0 0; font-size: clamp(18px, 2vw, 24px); }
.home-weather-status { color: var(--home-success); font-size: 10px; font-weight: 800; letter-spacing: .12em; }
.home-weather-status.unavailable { color: var(--home-warning); }
.home-weather-message { margin: 20px 0 0; color: var(--home-muted); }
.home-weather-current { display: grid; grid-template-columns: auto 1fr; column-gap: 18px; align-items: center; margin-top: 22px; }
.home-weather-icon { grid-row: span 2; font-size: 46px; }
.home-weather-current strong { font-size: clamp(36px, 5vw, 54px); line-height: 1; }
.home-weather-current strong small { margin-left: 4px; color: var(--home-muted); font-size: 20px; }
.home-weather-current p { margin: 5px 0 0; color: var(--home-muted); }
.home-weather-meta { display: flex; gap: 18px; margin: 18px 0; color: var(--home-muted); font-size: 12px; }
.home-weather-forecast { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
.home-weather-forecast article { display: grid; justify-items: start; gap: 5px; padding: 12px; border: 1px solid var(--home-border); border-radius: 12px; background: var(--home-surface-soft); }
.home-weather-forecast span, .home-weather-forecast small { color: var(--home-muted); font-size: 11px; }
.home-weather-forecast strong { font-size: 19px; }
.home-weather-forecast b { font-size: 14px; }
@media (max-width: 600px) { .home-weather-forecast { grid-template-columns: 1fr; } }
</style>
