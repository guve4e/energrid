<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';

const props = defineProps<{
  apiBase: string;
  accessToken: string;
}>();

type Point = {
  timestamp: string;
  temperature: number;
  samples: number;
};

type Sensor = {
  id: string;
  name: string;
  points: Point[];
};

type HistoryResponse = {
  from: string;
  to: string;
  interval: string;
  source: string;
  sensors: Sensor[];
};

const history = ref<HistoryResponse | null>(null);
const loading = ref(true);
const error = ref('');

let controller: AbortController | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

const width = 800;
const height = 200;
const padding = { left: 42, right: 15, top: 15, bottom: 28 };

const colors: Record<string, string> = {
  'temp-kitchen': '#75e4ba',
  'temp-garage': '#63b9ff',
  'temp-bolier-room': '#f3b86b',
};

const sensors = computed(() =>
  (history.value?.sensors ?? []).filter(
    sensor => sensor.points.length > 0,
  ),
);

const bounds = computed(() => {
  const values = sensors.value.flatMap(sensor =>
    sensor.points.map(point => point.temperature),
  );

  if (!values.length) return { min: 0, max: 30 };

  const min = Math.floor(Math.min(...values) - 1);
  const max = Math.ceil(Math.max(...values) + 1);

  return {
    min,
    max: max > min ? max : min + 1,
  };
});

function xPosition(timestamp: string) {
  if (!history.value) return padding.left;

  const from = Date.parse(history.value.from);
  const to = Date.parse(history.value.to);
  const current = Date.parse(timestamp);

  return padding.left +
    ((current - from) / Math.max(1, to - from)) *
    (width - padding.left - padding.right);
}

function yPosition(value: number) {
  const range = bounds.value.max - bounds.value.min;

  return padding.top +
    ((bounds.value.max - value) / range) *
    (height - padding.top - padding.bottom);
}

function segments(points: Point[]) {
  const sorted = [...points]
    .filter(point =>
      Number.isFinite(point.temperature) &&
      Number.isFinite(Date.parse(point.timestamp)),
    )
    .sort(
      (a, b) =>
        Date.parse(a.timestamp) - Date.parse(b.timestamp),
    );

  const result: string[] = [];
  let current: string[] = [];
  let previousTime: number | null = null;

  for (const point of sorted) {
    const time = Date.parse(point.timestamp);

    // Never connect across missing hourly observations.
    if (
      previousTime !== null &&
      time - previousTime > 90 * 60 * 1000
    ) {
      if (current.length) result.push(current.join(' '));
      current = [];
    }

    current.push(
      `${current.length ? 'L' : 'M'} ${xPosition(point.timestamp).toFixed(1)} ${yPosition(point.temperature).toFixed(1)}`,
    );

    previousTime = time;
  }

  if (current.length) result.push(current.join(' '));

  return result;
}

function stats(points: Point[]) {
  const values = points
    .map(point => point.temperature)
    .filter(Number.isFinite);

  if (!values.length) return null;

  return {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: values.reduce((a, b) => a + b, 0) / values.length,
  };
}

function timeLabel(fraction: number) {
  if (!history.value) return '';

  const from = Date.parse(history.value.from);
  const to = Date.parse(history.value.to);

  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Sofia',
  }).format(new Date(from + (to - from) * fraction));
}

async function load() {
  controller?.abort();

  const current = new AbortController();
  controller = current;

  loading.value = true;

  try {
    const response = await fetch(
      `${props.apiBase}/portal/energy/temperatures/history?hours=24`,
      {
        headers: {
          Authorization: `Bearer ${props.accessToken}`,
        },
        signal: current.signal,
      },
    );

    if (!response.ok) {
      throw new Error(`Temperature history API: ${response.status}`);
    }

    const data = (await response.json()) as HistoryResponse;

    if (current.signal.aborted) return;

    history.value = data;
    error.value = '';
  } catch (cause) {
    if (current.signal.aborted) return;

    error.value =
      cause instanceof Error ? cause.message : 'History unavailable';
  } finally {
    if (!current.signal.aborted) loading.value = false;
  }
}

onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 5 * 60_000);
});

onBeforeUnmount(() => {
  controller?.abort();
  if (timer) clearInterval(timer);
});
</script>

<template>
  <section class="temperature-history">
    <div class="history-header">
      <div>
        <span class="eyebrow">ENVIRONMENT INTELLIGENCE</span>
        <h2>Temperature history <small>Last 24 hours</small></h2>
      </div>
      <span class="source-label">HISTORICAL · MONGODB</span>
    </div>

    <p v-if="loading && !history" class="message">
      Loading historical measurements…
    </p>

    <p v-else-if="error" class="message">
      {{ error }}
    </p>

    <p v-else-if="!sensors.length" class="message">
      No historical temperature measurements available.
    </p>

    <template v-else>
      <div class="legend">
        <div
          v-for="sensor in sensors"
          :key="sensor.id"
          class="legend-item"
        >
          <span
            class="legend-dot"
            :style="{ background: colors[sensor.id] || '#ffffff' }"
          ></span>
          <strong>{{ sensor.name }}</strong>
          <small>
            {{ sensor.points.length }} hourly readings
          </small>
        </div>
      </div>

      <svg
        class="history-chart"
        :viewBox="`0 0 ${width} ${height}`"
        role="img"
        aria-label="Historical room temperatures over the last 24 hours"
      >
        <g v-for="step in 5" :key="step">
          <line
            :x1="padding.left"
            :x2="width - padding.right"
            :y1="padding.top + (step - 1) * (height - padding.top - padding.bottom) / 4"
            :y2="padding.top + (step - 1) * (height - padding.top - padding.bottom) / 4"
            stroke="#ffffff"
            stroke-opacity=".09"
          />

          <text
            :x="padding.left - 8"
            :y="padding.top + (step - 1) * (height - padding.top - padding.bottom) / 4 + 4"
            fill="#8fa9a5"
            font-size="11"
            text-anchor="end"
          >
            {{ (bounds.max - (step - 1) * (bounds.max - bounds.min) / 4).toFixed(0) }}°
          </text>
        </g>

        <g v-for="sensor in sensors" :key="sensor.id">
          <path
            v-for="(segment, index) in segments(sensor.points)"
            :key="index"
            :d="segment"
            fill="none"
            :stroke="colors[sensor.id] || '#ffffff'"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </g>

        <g v-for="step in 5" :key="`time-${step}`">
          <text
            :x="padding.left + (step - 1) * (width - padding.left - padding.right) / 4"
            :y="height - 5"
            fill="#8fa9a5"
            font-size="11"
            text-anchor="middle"
          >
            {{ timeLabel((step - 1) / 4) }}
          </text>
        </g>
      </svg>

      <div class="stats-grid">
        <div
          v-for="sensor in sensors"
          :key="sensor.id"
          class="sensor-stats"
        >
          <strong>{{ sensor.name }}</strong>
          <span>Min {{ stats(sensor.points)?.min.toFixed(1) }}°</span>
          <span>Max {{ stats(sensor.points)?.max.toFixed(1) }}°</span>
          <span>Avg {{ stats(sensor.points)?.avg.toFixed(1) }}°</span>
        </div>
      </div>

      <p class="history-note">
        Hourly historical averages. Gaps indicate missing data.
        Historical measurements do not establish live sensor connectivity.
      </p>
    </template>
  </section>
</template>

<style scoped>
.temperature-history {
  min-width: 0;
  padding: 18px 20px;
  border: 1px solid #ffffff16;
  border-radius: 14px;
  background: linear-gradient(145deg, #1a3037, #12232b);
  color: #eaf4f0;
}

.history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 15px;
}

.eyebrow {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .15em;
  color: #69c9ae;
}

.history-header h2 {
  margin: 6px 0;
  font-size: 18px;
  font-weight: 500;
}

.history-header h2 small {
  font-size: 11px;
  font-weight: 400;
  color: #8fa9a5;
  margin-left: 8px;
}

.source-label {
  font-size: 9px;
  color: #83a69f;
  letter-spacing: .1em;
}

.message {
  padding: 35px 0;
  color: #9eb6b1;
  font-size: 13px;
}

.legend {
  display: flex;
  gap: 22px;
  flex-wrap: wrap;
  margin: 14px 0;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
}

.legend-item small {
  color: #87a29d;
  font-size: 10px;
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.history-chart {
  display: block;
  width: 100%;
  height: auto;
  max-height: 210px;
  overflow: visible;
}

.stats-grid {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
  margin-top: 8px;
  padding-top: 12px;
  border-top: 1px solid #ffffff16;
}

.sensor-stats {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 11px;
  color: #a9c5bb;
}

.sensor-stats strong {
  color: #eaf4f0;
}

.history-note {
  margin: 14px 0 0;
  font-size: 10px;
  color: #77948d;
}

@media (max-width: 650px) {
  .source-label {
    display: none;
  }

  .sensor-stats {
    flex-wrap: wrap;
  }
}
</style>
