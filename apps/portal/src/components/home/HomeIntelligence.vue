<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';

const props = defineProps<{
  apiBase: string;
  accessToken: string;
}>();

type ForecastDay = {
  date: string;
  condition?: string;
  weatherCode?: number | null;
  tempMax?: number | null;
  tempMin?: number | null;
  rainChanceMax?: number | null;
  rainTotalMm?: number | null;
};

type Weather = {
  location: string;
  fetchedAt: string;
  current: {
    temperature: number | null;
    windKmh: number | null;
    gustKmh: number | null;
  };
  intelligence?: {
    headline?: string;
    rain?: {
      totalMm: number;
      maxRainChance: number;
    };
  };
  daily?: ForecastDay[];
  dataQuality?: { status: string };
};

type EnergyAsset = {
  id: string;
  displayName: string;
};

type EnergyDay = {
  date: string;
  energyKwh: number | null;
  coveragePct: number;
};

type EnergyHour = {
  from: string;
  energyKwh: number | null;
  coveragePct: number;
};

type EnergyHistory = {
  asset: EnergyAsset;
  daily: EnergyDay[];
  hourly: EnergyHour[];
  summary: {
    energyKwh: number | null;
    coveragePct: number;
  };
};

const weather = ref<Weather | null>(null);
const energy = ref<EnergyHistory | null>(null);
const energyAssets = ref<EnergyAsset[]>([]);
const selectedAsset = ref('');
const weatherError = ref('');
const energyError = ref('');
const weatherLoading = ref(true);
const energyLoading = ref(true);

let weatherController: AbortController | undefined;
let energyController: AbortController | undefined;
let weatherTimer: ReturnType<typeof setInterval> | undefined;
let energyTimer: ReturnType<typeof setInterval> | undefined;

function format(value: number | null | undefined, digits = 1) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(digits)
    : '—';
}

function weatherIcon(code?: number | null) {
  if ([95, 96, 99].includes(code ?? -1)) return '⛈';
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code ?? -1))
    return '☂';
  if ([71, 73, 75, 77, 85, 86].includes(code ?? -1)) return '❄';
  if ([2, 3, 45, 48].includes(code ?? -1)) return '☁';
  if ([0, 1].includes(code ?? -1)) return '☀';
  return '◌';
}

function dayLabel(date: string) {
  return new Intl.DateTimeFormat('en', {
    weekday: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
}

function authenticated(path: string, signal: AbortSignal) {
  return fetch(`${props.apiBase}${path}`, {
    headers: { Authorization: `Bearer ${props.accessToken}` },
    signal,
  });
}

async function loadWeather() {
  weatherController?.abort();
  const controller = new AbortController();
  weatherController = controller;
  weatherLoading.value = true;

  try {
    const response = await authenticated(
      '/portal/weather/dashboard',
      controller.signal,
    );

    if (!response.ok) throw new Error(`Weather API: ${response.status}`);

    const result = (await response.json()) as Weather;

    if (controller.signal.aborted) return;

    weather.value = result;
    weatherError.value = '';
  } catch (error) {
    if (controller.signal.aborted) return;
    weather.value = null;
    weatherError.value =
      error instanceof Error ? error.message : 'Weather unavailable';
  } finally {
    if (!controller.signal.aborted) weatherLoading.value = false;
  }
}

async function loadEnergy(reloadAssets = false) {
  energyController?.abort();
  const controller = new AbortController();
  energyController = controller;
  energyLoading.value = true;

  try {
    if (reloadAssets || !selectedAsset.value) {
      const response = await authenticated(
        '/portal/energy/assets',
        controller.signal,
      );

      if (!response.ok) throw new Error(`Energy API: ${response.status}`);

      const result = (await response.json()) as {
        configured: boolean;
        assets: EnergyAsset[];
      };

      if (!result.configured) {
        throw new Error('Energy history is not configured');
      }

      energyAssets.value = result.assets;

      if (!result.assets.some((asset) => asset.id === selectedAsset.value)) {
        selectedAsset.value = result.assets[0]?.id ?? '';
      }
    }

    if (!selectedAsset.value) {
      energy.value = null;
      energyError.value = 'No energy assets assigned to this site';
      return;
    }

    const to = new Date();
    const from = new Date(to.getTime() - 7 * 86400000);

    const query = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
    });

    const response = await authenticated(
      `/portal/energy/assets/${encodeURIComponent(selectedAsset.value)}/history?${query}`,
      controller.signal,
    );

    if (!response.ok) throw new Error(`Energy history: ${response.status}`);

    const result = (await response.json()) as EnergyHistory;

    if (controller.signal.aborted) return;

    energy.value = result;
    energyError.value = '';
  } catch (error) {
    if (controller.signal.aborted) return;
    energy.value = null;
    energyError.value =
      error instanceof Error ? error.message : 'Energy unavailable';
  } finally {
    if (!controller.signal.aborted) energyLoading.value = false;
  }
}

const recentHours = computed(() =>
  (energy.value?.hourly ?? [])
    .filter((hour) => {
      const time = Date.parse(hour.from);
      return Number.isFinite(time) &&
        time >= Date.now() - 24 * 3600000;
    })
    .sort((a, b) => Date.parse(a.from) - Date.parse(b.from)),
);

const recentDays = computed(() =>
  (energy.value?.daily ?? []).slice(-7),
);

function barHeight(value: number | null, max: number) {
  if (value === null || !Number.isFinite(value)) return 0;
  return Math.max(value > 0 ? 3 : 0, (value / max) * 100);
}

const maxHourly = computed(() =>
  Math.max(0.01, ...recentHours.value.map((h) => h.energyKwh ?? 0)),
);

const maxDaily = computed(() =>
  Math.max(0.01, ...recentDays.value.map((d) => d.energyKwh ?? 0)),
);

const weatherFresh = computed(() => {
  if (!weather.value?.fetchedAt) return false;
  const age = Date.now() - Date.parse(weather.value.fetchedAt);
  return Number.isFinite(age) &&
    age >= 0 &&
    age < 3 * 3600000 &&
    weather.value.dataQuality?.status === 'available';
});

onMounted(() => {
  void loadWeather();
  void loadEnergy(true);

  weatherTimer = setInterval(() => void loadWeather(), 5 * 60000);
  energyTimer = setInterval(() => void loadEnergy(), 5 * 60000);
});

onBeforeUnmount(() => {
  weatherController?.abort();
  energyController?.abort();
  if (weatherTimer) clearInterval(weatherTimer);
  if (energyTimer) clearInterval(energyTimer);
});
</script>

<template>
  <div class="intelligence-grid">
    <section class="intel-card weather-panel">
      <div class="intel-heading">
        <div>
          <span class="intel-eyebrow">WEATHER INTELLIGENCE</span>
          <h2>{{ weather?.location || 'Vidin' }}</h2>
        </div>
        <span class="intel-indicator" :class="{ inactive: !weatherFresh }">
          {{ weatherFresh ? 'CURRENT' : 'UNAVAILABLE' }}
        </span>
      </div>

      <p v-if="weatherLoading && !weather" class="intel-muted">
        Loading weather…
      </p>
      <p v-else-if="weatherError" class="intel-muted">
        {{ weatherError }}
      </p>

      <template v-if="weather && weatherFresh">
        <div class="weather-current">
          <div class="weather-temp">
            {{ format(weather.current.temperature, 0) }}<small>°C</small>
          </div>
          <div class="weather-wind">
            <span>Wind {{ format(weather.current.windKmh, 0) }} km/h</span>
            <span>Gusts {{ format(weather.current.gustKmh, 0) }} km/h</span>
          </div>
        </div>

        <p class="weather-headline">
          {{ weather.intelligence?.headline || 'Forecast available' }}
        </p>

        <div class="forecast-grid">
          <div
            v-for="day in weather.daily?.slice(0, 3)"
            :key="day.date"
            class="forecast-day"
          >
            <span>{{ dayLabel(day.date) }}</span>
            <strong class="forecast-icon">{{ weatherIcon(day.weatherCode) }}</strong>
            <b>{{ format(day.tempMax, 0) }}° / {{ format(day.tempMin, 0) }}°</b>
            <small>☂ {{ format(day.rainChanceMax, 0) }}%</small>
          </div>
        </div>
      </template>
    </section>

    <section class="intel-card energy-panel">
      <div class="intel-heading">
        <div>
          <span class="intel-eyebrow">ENERGY INTELLIGENCE</span>
          <h2>Consumption</h2>
        </div>
        <select
          v-if="energyAssets.length > 1"
          v-model="selectedAsset"
          class="asset-select"
          @change="loadEnergy()"
        >
          <option v-for="asset in energyAssets" :key="asset.id" :value="asset.id">
            {{ asset.displayName }}
          </option>
        </select>
      </div>

      <p v-if="energyLoading && !energy" class="intel-muted">
        Loading energy history…
      </p>
      <p v-else-if="energyError" class="intel-muted">
        {{ energyError }}
      </p>

      <template v-if="energy">
        <div class="energy-overview">
          <div>
            <span>LAST 7 DAYS · ESTIMATED</span>
            <strong>{{ format(energy.summary.energyKwh, 1) }} <small>kWh</small></strong>
          </div>
          <div>
            <span>DATA COVERAGE</span>
            <strong>{{ format(energy.summary.coveragePct, 0) }}<small>%</small></strong>
          </div>
        </div>

        <h3>Hourly energy · last 24 hours</h3>
        <div v-if="recentHours.length" class="bar-chart hourly-chart">
          <div
            v-for="hour in recentHours"
            :key="hour.from"
            class="chart-column"
            :title="`${hour.from}: ${format(hour.energyKwh, 2)} kWh · ${format(hour.coveragePct, 0)}% coverage`"
          >
            <div
              class="chart-bar"
              :class="{ missing: hour.energyKwh === null }"
              :style="{ height: `${barHeight(hour.energyKwh, maxHourly)}%` }"
            ></div>
          </div>
        </div>
        <p v-else class="intel-muted">No hourly readings available.</p>

        <h3>Daily energy · last 7 days</h3>
        <div v-if="recentDays.length" class="bar-chart daily-chart">
          <div
            v-for="day in recentDays"
            :key="day.date"
            class="chart-column"
            :title="`${day.date}: ${format(day.energyKwh, 2)} kWh · ${format(day.coveragePct, 0)}% coverage`"
          >
            <div
              class="chart-bar"
              :class="{ missing: day.energyKwh === null }"
              :style="{ height: `${barHeight(day.energyKwh, maxDaily)}%` }"
            ></div>
            <span>{{ dayLabel(day.date) }}</span>
          </div>
        </div>
        <p v-else class="intel-muted">No daily readings available.</p>

        <p class="energy-disclaimer">
          Estimated from recorded power. Missing periods are not treated as zero.
        </p>
      </template>
    </section>
  </div>
</template>

<style scoped>
.intelligence-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr);
  gap: 14px;
  margin: 0 0 22px;
  font-family: Inter, -apple-system, sans-serif;
}

.intel-card {
  min-width: 0;
  padding: 20px;
  border: 1px solid #ffffff16;
  border-radius: 16px;
  background: linear-gradient(145deg, #1a3037, #12232b);
  color: #eaf4f0;
}

.intel-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
}

.intel-eyebrow {
  color: #69c9ae;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .14em;
}

.intel-heading h2 {
  margin: 5px 0 0;
  font-size: 19px;
  font-weight: 500;
}

.intel-indicator {
  color: #7ce7b6;
  font-size: 10px;
}

.intel-indicator.inactive {
  color: #dba989;
}

.intel-muted {
  color: #92aaa8;
  font-size: 13px;
}

.weather-current {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.weather-temp {
  font-size: 65px;
  font-weight: 300;
  letter-spacing: -.06em;
}

.weather-temp small {
  font-size: 24px;
  color: #92b5ae;
}

.weather-wind {
  display: grid;
  gap: 8px;
  color: #a8bfbc;
  font-size: 12px;
}

.weather-headline {
  color: #a8d8ca;
  font-size: 12px;
  min-height: 30px;
}

.forecast-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 20px;
}

.forecast-day {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 12px 5px;
  background: #ffffff08;
  border-radius: 10px;
  font-size: 12px;
}

.forecast-icon {
  font-size: 28px;
  font-weight: 400;
}

.forecast-day small {
  color: #92b7ae;
}

.asset-select {
  max-width: 155px;
  background: #20383c;
  color: #e5f2eb;
  border: 1px solid #ffffff25;
  border-radius: 7px;
  padding: 7px;
}

.energy-overview {
  display: flex;
  gap: 30px;
  margin-bottom: 20px;
}

.energy-overview > div {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.energy-overview span {
  color: #90aca7;
  font-size: 10px;
  letter-spacing: .08em;
}

.energy-overview strong {
  font-size: 29px;
  font-weight: 400;
}

.energy-overview small {
  font-size: 13px;
  color: #9fbab3;
}

.energy-panel h3 {
  font-size: 12px;
  font-weight: 500;
  color: #bdd3cb;
  margin: 15px 0 10px;
}

.bar-chart {
  height: 95px;
  display: flex;
  align-items: stretch;
  gap: 4px;
  border-bottom: 1px solid #ffffff20;
}

.chart-column {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: stretch;
  position: relative;
}

.chart-bar {
  width: 100%;
  min-height: 0;
  background: linear-gradient(0deg, #277b77, #7de8b6);
  border-radius: 3px 3px 0 0;
}

.chart-bar.missing {
  background: transparent;
  border: 1px dashed #ffffff20;
  box-sizing: border-box;
}

.daily-chart {
  height: 110px;
  padding-bottom: 20px;
}

.daily-chart .chart-column span {
  position: absolute;
  bottom: -18px;
  width: 100%;
  text-align: center;
  color: #90aaa6;
  font-size: 10px;
}

.energy-disclaimer {
  margin: 24px 0 0;
  color: #7e9994;
  font-size: 10px;
}

@media (max-width: 850px) {
  .intelligence-grid {
    grid-template-columns: 1fr;
  }
}
</style>

<style scoped>
.intelligence-grid {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr);
  gap: 12px;
  margin: 0;
}

.intel-card {
  padding: 18px;
}

.weather-temp {
  font-size: 48px;
}

.forecast-grid {
  margin-top: 12px;
}

.forecast-day {
  padding: 9px 3px;
}

.energy-overview {
  gap: 14px;
  margin-bottom: 10px;
}

.energy-overview strong {
  font-size: 24px;
}

.bar-chart {
  height: 60px;
}

.daily-chart {
  height: 72px;
}

.energy-disclaimer {
  margin-top: 14px;
}

@media (max-width: 950px) {
  .intelligence-grid {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 650px) {
  .intelligence-grid {
    grid-template-columns: 1fr;
  }
}
</style>
