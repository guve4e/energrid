<script setup lang="ts">
import { computed, ref } from 'vue';
import type {
  ForecastDay,
  ForecastDayDetails,
  ForecastHour,
} from './forecast-types';

const props = defineProps<{ day: ForecastDay; detail?: ForecastDayDetails }>();
const mode = ref<'rain' | 'temperature' | 'wind'>('rain');
const modes = ['rain', 'temperature', 'wind'] as const;
const names: Record<string, string> = {
  icon_seamless: 'DWD ICON',
  ncep_gfs_seamless: 'NOAA GFS',
};
const model = (name?: string | null) =>
  names[name || ''] || name || 'Selected forecast';
const n = (value?: number | null, digits = 1) =>
  value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
const timezone = computed(() => props.detail?.timezone || 'Europe/Sofia');
const time = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat(undefined, {
        timeZone: timezone.value,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(value))
    : '—';
const title = computed(() =>
  new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(`${props.day.date}T12:00:00`)),
);
const agreement = computed(() =>
  props.day.agreement === 'agreement'
    ? 'Models agree'
    : props.day.agreement === 'disagreement'
      ? 'Cautious · models differ'
      : props.day.agreement === 'single-model'
        ? 'Single model'
        : 'Agreement unavailable',
);
const series = computed(
  (): Array<{
    field: keyof ForecastHour;
    label: string;
    color: string;
    dashed?: boolean;
  }> =>
    mode.value === 'rain'
      ? [{ field: 'precipitationMm', label: 'Rain · mm', color: '#2563eb' }]
      : mode.value === 'temperature'
        ? [
            {
              field: 'temperature',
              label: 'Temperature · °C',
              color: '#c24154',
            },
            {
              field: 'feelsLike',
              label: 'Feels like · °C',
              color: '#64748b',
              dashed: true,
            },
          ]
        : [
            { field: 'windKmh', label: 'Wind · km/h', color: '#0f8a72' },
            {
              field: 'gustKmh',
              label: 'Gust · km/h',
              color: '#c77509',
              dashed: true,
            },
          ],
);
const chart = computed(() => {
  const detail = props.detail;
  if (!detail?.hours.length) return null;
  const values = detail.hours.flatMap((h) =>
    series.value
      .map((s) => h[s.field])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v)),
  );
  if (!values.length) return null;
  const min =
    mode.value === 'temperature' ? Math.floor(Math.min(...values) - 1) : 0;
  const max = Math.max(
    min + 1,
    Math.ceil(Math.max(...values) + (mode.value === 'temperature' ? 1 : 0)),
  );
  const x = (instant: number) =>
    48 +
    (((instant - Date.parse(detail.startsAt)) / 3600000 + 0.5) /
      detail.coverage.expectedHours) *
      924;
  const y = (value: number) => 186 - ((value - min) / (max - min)) * 160;
  const paths = series.value.map((s) => {
    let previous = NaN;
    const path = detail.hours
      .map((h) => {
        const value = h[s.field];
        const instant = Date.parse(h.time);
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          previous = NaN;
          return '';
        }
        const command = instant - previous === 3600000 ? 'L' : 'M';
        previous = instant;
        return `${command}${x(instant)},${y(value)}`;
      })
      .join(' ');
    return { ...s, path };
  });
  return {
    paths,
    y,
    x,
    min,
    max,
    width: 924 / detail.coverage.expectedHours,
    ticks: Array.from({ length: 4 }, (_, i) => min + ((max - min) * i) / 3),
    labels: Array.from({ length: detail.coverage.expectedHours }, (_, i) =>
      new Date(Date.parse(detail.startsAt) + i * 3600000).toISOString(),
    ).filter((_, i) => i % 3 === 0),
  };
});
</script>

<template>
  <section class="day-detail" aria-labelledby="selected-day-title">
    <header class="detail-header">
      <div>
        <p class="detail-eyebrow">Selected day · forecast</p>
        <h3 id="selected-day-title" aria-live="polite">{{ title }}</h3>
        <p>{{ day.condition }} · {{ model(day.sourceModel) }}</p>
      </div>
      <span
        :class="[
          'agreement-badge',
          { cautious: day.agreement === 'disagreement' },
        ]"
        >{{ agreement }}</span
      >
    </header>
    <dl class="detail-summary">
      <div>
        <dt>High / Low</dt>
        <dd>{{ n(day.tempMax) }}° / {{ n(day.tempMin) }}°</dd>
      </div>
      <div>
        <dt>Rain total</dt>
        <dd>{{ n(day.rainTotalMm) }} mm</dd>
        <small>{{ n(day.rainTotalMm) }} L/m²</small>
      </div>
      <div>
        <dt>Peak rain chance</dt>
        <dd>{{ n(day.rainChanceMax, 0) }}%</dd>
      </div>
      <div>
        <dt>Max gust</dt>
        <dd>{{ n(day.gustMaxKmh, 0) }} km/h</dd>
      </div>
    </dl>
    <p v-if="day.selectionReason" class="detail-muted">
      {{ day.selectionReason }}
    </p>
    <template v-if="detail?.hours.length">
      <div class="chart-toolbar">
        <div class="chart-modes" role="group" aria-label="Hourly measurement">
          <button
            v-for="item in modes"
            :key="item"
            type="button"
            :aria-pressed="mode === item"
            @click="mode = item"
          >
            {{ item }}
          </button>
        </div>
        <span class="detail-muted"
          >{{ detail.coverage.availableHours }}/{{
            detail.coverage.expectedHours
          }}
          hours · {{ timezone }}</span
        >
      </div>
      <p
        v-if="detail.coverage.status !== 'complete'"
        class="detail-coverage"
        role="status"
      >
        Partial hourly forecast. Missing values remain unavailable.
      </p>
      <div v-if="chart" class="hourly-chart">
        <div class="chart-legend">
          <span v-for="s in series" :key="s.field"
            ><i :style="{ background: s.color }"></i>{{ s.label }}</span
          ><span>{{ n(chart.min) }}–{{ n(chart.max) }}</span>
        </div>
        <svg
          viewBox="0 0 1000 230"
          preserveAspectRatio="none"
          role="img"
          :aria-label="`${mode} forecast for ${title}; values in hourly parameters below`"
        >
          <g v-for="tick in chart.ticks" :key="tick">
            <line
              x1="48"
              x2="972"
              :y1="chart.y(tick)"
              :y2="chart.y(tick)"
              stroke="currentColor"
              opacity=".12"
            />
            <text x="2" :y="chart.y(tick) + 4">{{ n(tick) }}</text>
          </g>
          <template v-if="mode === 'rain'">
            <rect
              v-for="h in detail.hours.filter(
                (h) =>
                  typeof h.precipitationMm === 'number' &&
                  Number.isFinite(h.precipitationMm),
              )"
              :key="h.time"
              :x="chart.x(Date.parse(h.time)) - chart.width * 0.3"
              :y="chart.y(h.precipitationMm!)"
              :width="chart.width * 0.6"
              :height="Math.max(0, 186 - chart.y(h.precipitationMm!))"
              fill="#2563eb"
            >
              <title>
                {{ time(h.time) }} · {{ n(h.precipitationMm) }} mm ·
                {{ n(h.rainChance, 0) }}% chance
              </title>
            </rect>
          </template>
          <template v-else>
            <g v-for="s in chart.paths" :key="s.field">
              <path
                :d="s.path"
                fill="none"
                :stroke="s.color"
                stroke-width="3"
                :stroke-dasharray="s.dashed ? '7 5' : undefined"
              />
              <circle
                v-for="h in detail.hours.filter(
                  (h) =>
                    typeof h[s.field] === 'number' &&
                    Number.isFinite(h[s.field]),
                )"
                :key="h.time"
                :cx="chart.x(Date.parse(h.time))"
                :cy="chart.y(h[s.field] as number)"
                r="3"
                :fill="s.color"
              />
            </g>
          </template>
          <rect
            v-for="h in detail.hours"
            :key="`hover-${h.time}`"
            :x="chart.x(Date.parse(h.time)) - chart.width / 2"
            y="20"
            :width="chart.width"
            height="170"
            fill="transparent"
          >
            <title>
              {{ time(h.time) }} ·
              {{
                series
                  .map((s) => `${s.label}: ${n(h[s.field] as number | null)}`)
                  .join(' · ')
              }}{{ mode === 'rain' ? ` · ${n(h.rainChance, 0)}% chance` : '' }}
            </title>
          </rect>
          <text
            v-for="instant in chart.labels"
            :key="instant"
            :x="chart.x(Date.parse(instant))"
            y="216"
            text-anchor="middle"
          >
            {{ time(instant) }}
          </text>
        </svg>
        <div class="mobile-chart-times">
          <span
            v-for="instant in chart.labels.filter((_, i) => i % 2 === 0)"
            :key="instant"
            >{{ time(instant) }}</span
          >
        </div>
      </div>
      <p v-else class="detail-muted">
        {{ mode }} values are unavailable for this day.
      </p>
      <dl class="detail-statistics">
        <div>
          <dt title="Forecast hours with at least 0.1 mm of precipitation">
            Wet hours
          </dt>
          <dd>
            {{ n(detail.statistics.wetHours, 0) }} /
            {{ detail.coverage.precipitationHours }}
          </dd>
        </div>
        <div>
          <dt>Heaviest hour</dt>
          <dd>{{ n(detail.statistics.maxHourlyMm) }} mm</dd>
          <small>{{ time(detail.statistics.peakRainAt) }}</small>
        </div>
        <div>
          <dt>Average humidity</dt>
          <dd>{{ n(detail.statistics.meanHumidityPct, 0) }}%</dd>
        </div>
        <div>
          <dt>Average pressure</dt>
          <dd>{{ n(detail.statistics.meanPressureHpa, 0) }} hPa</dd>
        </div>
      </dl>
      <p class="detail-muted rain-windows">
        Rain windows:
        {{
          detail.statistics.rainWindows.length
            ? detail.statistics.rainWindows
                .map((w) => `${time(w.startsAt)}–${time(w.endsAt)}`)
                .join(' · ')
            : detail.statistics.wetHours === 0
              ? 'No measurable rain in available hours.'
              : 'Unavailable.'
        }}
      </p>
      <details class="detail-table">
        <summary>Hourly parameters</summary>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Conditions</th>
                <th>Temp °C</th>
                <th>Feels °C</th>
                <th>Rain mm</th>
                <th>Chance %</th>
                <th>Wind km/h</th>
                <th>Gust km/h</th>
                <th>Humidity %</th>
                <th>Pressure hPa</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="h in detail.hours" :key="h.time">
                <th>{{ time(h.time) }}</th>
                <td>{{ h.condition }}</td>
                <td>{{ n(h.temperature) }}</td>
                <td>{{ n(h.feelsLike) }}</td>
                <td>{{ n(h.precipitationMm) }}</td>
                <td>{{ n(h.rainChance, 0) }}</td>
                <td>{{ n(h.windKmh, 0) }}</td>
                <td>{{ n(h.gustKmh, 0) }}</td>
                <td>{{ n(h.humidity, 0) }}</td>
                <td>{{ n(h.pressure, 0) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </template>
    <p v-else class="detail-coverage" role="status">
      Hourly details unavailable for this day. Daily forecast shown above.
    </p>
    <details v-if="detail?.models.length" class="detail-table">
      <summary>Compare models · {{ detail.models.length }}</summary>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>High / Low °C</th>
              <th>Rain mm</th>
              <th>Chance %</th>
              <th>Gust km/h</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="m in detail.models"
              :key="`${m.provider}:${m.model}`"
              :class="{
                chosen:
                  m.model === detail.sourceModel &&
                  m.provider === detail.sourceProvider,
              }"
            >
              <th>
                {{ model(m.model)
                }}{{
                  m.model === detail.sourceModel &&
                  m.provider === detail.sourceProvider
                    ? ' · shown'
                    : ''
                }}
              </th>
              <td>{{ n(m.tempMax) }} / {{ n(m.tempMin) }}</td>
              <td>{{ n(m.rainTotalMm) }}</td>
              <td>{{ n(m.rainChanceMax, 0) }}</td>
              <td>{{ n(m.gustMaxKmh, 0) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  </section>
</template>

<style scoped>
.day-detail {
  min-width: 0;
  border-top: 1px solid #d8e0ec;
  padding-top: 24px;
  color: inherit;
  letter-spacing: 0;
}
.detail-header,
.chart-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.detail-header h3 {
  font-size: 26px;
  margin: 4px 0 8px;
}
.detail-header p {
  margin: 0;
}
.detail-eyebrow {
  font-size: 12px;
  color: #2563eb;
  font-weight: 700;
}
.detail-muted {
  color: #64748b;
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.agreement-badge {
  font-size: 12px;
  font-weight: 700;
  padding: 6px 10px;
  background: #eef5ff;
  color: #1d4ed8;
  border-radius: 6px;
}
.agreement-badge.cautious {
  background: #fff4d8;
  color: #8a5200;
}
.detail-summary,
.detail-statistics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  padding: 18px 0;
  margin: 0;
  border-bottom: 1px solid #d8e0ec;
}
.detail-summary dt,
.detail-statistics dt {
  font-size: 12px;
  color: #64748b;
  margin-bottom: 7px;
}
.detail-summary dd,
.detail-statistics dd {
  font-size: 22px;
  font-weight: 750;
  margin: 0;
  overflow-wrap: anywhere;
}
.detail-statistics dd {
  font-size: 18px;
}
.day-detail small {
  display: block;
  font-size: 12px;
  color: #64748b;
  margin-top: 5px;
}
.chart-modes {
  display: flex;
  border: 1px solid #d8e0ec;
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
}
.chart-modes button {
  padding: 8px 12px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-transform: capitalize;
  cursor: pointer;
}
.chart-modes button[aria-pressed='true'] {
  background: #2563eb;
  color: #fff;
}
.chart-modes button:focus-visible,
summary:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: -2px;
}
.hourly-chart {
  min-width: 0;
}
.hourly-chart svg {
  width: 100%;
  height: auto;
  display: block;
  min-height: 150px;
}
.hourly-chart text {
  fill: currentColor;
  font: 12px system-ui;
}
.chart-legend {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  font-size: 12px;
  color: #64748b;
  margin: 4px 0;
}
.chart-legend i {
  display: inline-block;
  width: 18px;
  height: 3px;
  vertical-align: middle;
  margin-right: 6px;
}
.detail-coverage {
  padding: 10px 12px;
  background: #fff7e6;
  border-left: 3px solid #d99c2b;
  font-size: 13px;
  line-height: 1.5;
}
.detail-table {
  min-width: 0;
  border-top: 1px solid #d8e0ec;
  padding: 12px 0;
}
.detail-table summary {
  cursor: pointer;
  font-weight: 650;
  font-size: 13px;
}
.table-scroll {
  overflow-x: auto;
  max-width: 100%;
  margin-top: 12px;
}
.detail-table table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.detail-table th,
.detail-table td {
  padding: 10px;
  text-align: left;
  border-bottom: 1px solid #d8e0ec;
  white-space: nowrap;
}
.detail-table .chosen {
  background: #eef5ff;
}
.rain-windows {
  margin: 0;
}
.detail-summary > div,
.detail-statistics > div {
  display: block;
  min-width: 0;
}
.detail-summary dd,
.detail-statistics dd {
  text-align: left;
  line-height: 1.3;
}
.mobile-chart-times {
  display: none;
}
.day-detail {
  scroll-margin-top: 90px;
}
@media (max-width: 650px) {
  .detail-summary,
  .detail-statistics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .detail-header h3 {
    font-size: 22px;
  }
  .chart-toolbar {
    gap: 10px;
  }
  .hourly-chart svg {
    height: 150px;
    min-height: 0;
  }
  .hourly-chart text {
    display: none;
  }
  .mobile-chart-times {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: #64748b;
    padding: 0 3% 0 5%;
  }
  .detail-summary dd {
    font-size: 20px;
  }
}
.theme-dark .day-detail .detail-muted,
.theme-dark .day-detail dt,
.theme-dark .day-detail small,
.theme-dark .day-detail .chart-legend,
.theme-dark .day-detail .mobile-chart-times {
  color: #b0bfd1;
}
.theme-dark .day-detail,
.theme-dark .day-detail .detail-header h3 {
  color: #edf4f2;
}
.theme-dark .day-detail .detail-summary,
.theme-dark .day-detail .detail-statistics,
.theme-dark .day-detail .detail-table,
.theme-dark .day-detail .detail-table th,
.theme-dark .day-detail .detail-table td {
  border-color: #31415c;
}
.theme-dark .detail-coverage {
  background: #362a15;
  color: #ffe5aa;
}
.theme-dark .detail-table .chosen {
  background: #14223a;
}
</style>
