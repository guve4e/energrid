<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { PowerAsset } from '@energrid/domain-telemetry';
import { recentPowerRange, type EnergyDashboard } from './energy-types';

const props = defineProps<{ apiBase: string; accessToken: string }>();
const assets = ref<PowerAsset[]>([]);
const configured = ref(true);
const assetId = ref('');
const days = ref(7);
const dashboard = ref<EnergyDashboard | null>(null);
const selectedDate = ref('');
const loading = ref(false);
const error = ref('');
let controller: AbortController | undefined;
let revision = 0;
let disposed = false;
const selectedDay = computed(
  () =>
    dashboard.value?.daily.find((day) => day.date === selectedDate.value) ??
    dashboard.value?.daily.at(-1),
);
const selectedHours = computed(
  () =>
    dashboard.value?.hourly.filter(
      (hour) => hour.localDate === selectedDay.value?.date,
    ) ?? [],
);
const maxDayEnergy = computed(() =>
  Math.max(
    0.01,
    ...(dashboard.value?.daily.map((day) => day.energyKwh ?? 0) ?? []),
  ),
);
const maxHourEnergy = computed(() =>
  Math.max(0.01, ...selectedHours.value.map((hour) => hour.energyKwh ?? 0)),
);
const number = (value: number | null | undefined, digits = 2) =>
  value == null || !Number.isFinite(value) ? '--' : value.toFixed(digits);
const dateLabel = (date: string) =>
  new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
const instantLabel = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    timeZone: dashboard.value?.asset.timezone,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value));
const hourLabel = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    timeZone: dashboard.value?.asset.timezone,
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'shortOffset',
  }).format(new Date(value));

async function read(path: string, signal: AbortSignal) {
  const response = await fetch(`${props.apiBase}/portal/energy/${path}`, {
    headers: { Authorization: `Bearer ${props.accessToken}` },
    signal,
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error('Please sign in again.');
    let message = 'Power history is unavailable. Please retry.';
    try {
      const body = await response.json();
      if (typeof body.message === 'string') message = body.message;
    } catch {
      /* Keep the fallback for non-JSON responses. */
    }
    throw new Error(message);
  }
  return response.json();
}

async function refresh(loadAssets = false) {
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  const request = ++revision;
  const timeout = setTimeout(
    () => controller?.signal === signal && controller.abort(),
    25000,
  );
  loading.value = true;
  error.value = '';
  dashboard.value = null;
  try {
    if (loadAssets) {
      const result = (await read('assets', signal)) as {
        configured: boolean;
        assets: PowerAsset[];
      };
      if (disposed || request !== revision) return;
      configured.value = result.configured;
      assets.value = result.assets;
      if (!assets.value.some((asset) => asset.id === assetId.value))
        assetId.value = assets.value[0]?.id ?? '';
    }
    if (!configured.value || !assetId.value) return;
    const query = new URLSearchParams({ ...recentPowerRange(days.value) });
    const result = (await read(
      `assets/${encodeURIComponent(assetId.value)}/history?${query}`,
      signal,
    )) as EnergyDashboard;
    if (disposed || request !== revision) return;
    dashboard.value = result;
    if (!result.daily.some((day) => day.date === selectedDate.value))
      selectedDate.value = result.daily.at(-1)?.date ?? '';
  } catch (cause) {
    if (disposed || request !== revision) return;
    error.value = signal.aborted
      ? 'The history request timed out. Please retry.'
      : cause instanceof Error
        ? cause.message
        : 'Power history is unavailable.';
  } finally {
    clearTimeout(timeout);
    if (!disposed && request === revision) loading.value = false;
  }
}

function exportCsv() {
  if (!dashboard.value) return;
  const rows = [
    [
      'from_utc',
      'to_utc',
      'local_date',
      'estimated_kwh',
      'active_minutes',
      'coverage_pct',
    ],
    ...dashboard.value.hourly.map((hour) => [
      hour.from,
      hour.to,
      hour.localDate,
      hour.energyKwh ?? '',
      hour.activeMinutes ?? '',
      hour.coveragePct,
    ]),
  ];
  const url = URL.createObjectURL(
    new Blob([rows.map((row) => row.join(',')).join('\n')], {
      type: 'text/csv;charset=utf-8',
    }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `energy-${assetId.value}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

onMounted(() => {
  void refresh(true);
});
onBeforeUnmount(() => {
  disposed = true;
  revision++;
  controller?.abort();
});
</script>

<template>
  <section class="energy-page" aria-labelledby="energy-title">
    <header class="energy-header">
      <div>
        <p class="eyebrow">Energy intelligence</p>
        <h2 id="energy-title">Power history</h2>
      </div>
      <button type="button" :disabled="loading" @click="refresh(true)">
        {{ loading ? 'Loading...' : 'Refresh' }}
      </button>
    </header>
    <div class="energy-controls">
      <label
        >Appliance / circuit<select
          v-model="assetId"
          :disabled="!assets.length"
          @change="refresh()"
        >
          <option v-for="asset in assets" :key="asset.id" :value="asset.id">
            {{ asset.displayName }}
          </option>
        </select></label
      >
      <label
        >Period<select v-model.number="days" @change="refresh()">
          <option :value="1">Last 24 hours</option>
          <option :value="7">Last 7 days</option>
          <option :value="30">Last 30 days</option>
        </select></label
      >
      <p v-if="dashboard" class="energy-muted">
        {{ dashboard.asset.timezone }}<br />{{
          dashboard.asset.capacityLiters
            ? `${dashboard.asset.capacityLiters} L tank`
            : ''
        }}<span v-if="dashboard.asset.schedule">
          · Scheduled {{ dashboard.asset.schedule.start }}–{{
            dashboard.asset.schedule.end
          }}</span
        >
      </p>
    </div>
    <p v-if="error" class="energy-notice" role="alert">{{ error }}</p>
    <p v-else-if="loading" class="energy-muted" role="status">
      Reading power history...
    </p>
    <p v-else-if="!configured" class="energy-notice">
      History connection is not configured.
    </p>
    <p v-else-if="!assets.length" class="energy-notice">
      No appliances or circuits are assigned to this site.
    </p>
    <template v-if="dashboard">
      <p class="energy-muted">
        {{ instantLabel(dashboard.range.from) }} to
        {{ instantLabel(dashboard.range.to) }}
      </p>
      <dl class="energy-summary">
        <div>
          <dt>Estimated energy</dt>
          <dd>{{ number(dashboard.summary.energyKwh) }} <small>kWh</small></dd>
        </div>
        <div>
          <dt>Active time</dt>
          <dd>
            {{ number(dashboard.summary.activeMinutes, 0) }} <small>min</small>
          </dd>
        </div>
        <div>
          <dt>Outside schedule</dt>
          <dd>
            {{ number(dashboard.summary.outsideScheduleKwh) }}
            <small>kWh</small>
          </dd>
        </div>
        <div>
          <dt>Data coverage</dt>
          <dd>
            {{ number(dashboard.summary.coveragePct, 1) }}<small>%</small>
          </dd>
        </div>
      </dl>
      <p
        v-if="dashboard.summary.coveragePct < 95"
        class="energy-notice"
        role="status"
      >
        Incomplete history. Energy covers only
        {{ number(dashboard.summary.coveragePct, 1) }}% of the requested period.
      </p>
      <p class="energy-muted">
        Estimated from recorded power, not an energy meter total. Gaps over
        {{ dashboard.maxGapSeconds / 60 }} minutes are excluded. Timestamps
        reflect
        {{
          dashboard.timestampBasis === 'device-observed'
            ? 'device measurement time'
            : dashboard.timestampBasis === 'mixed'
              ? 'a mixture of device and collector times'
              : 'collector receipt time'
        }}.
      </p>
      <p v-if="dashboard.asset.measurementSources?.length" class="energy-muted">
        Measured by:
        {{
          dashboard.asset.measurementSources
            .map((m) => `${m.deviceId} · ${m.channel}`)
            .join(', ')
        }}
      </p>
      <section class="energy-section" aria-labelledby="daily-energy-title">
        <div class="energy-section-heading">
          <h3 id="daily-energy-title">
            Daily consumption <small class="energy-muted">kWh</small>
          </h3>
          <button type="button" @click="exportCsv">Export CSV</button>
        </div>
        <div class="energy-days">
          <button
            v-for="day in dashboard.daily"
            :key="day.date"
            type="button"
            class="energy-day"
            :aria-pressed="selectedDay?.date === day.date"
            :aria-label="`${dateLabel(day.date)}, ${day.energyKwh == null ? 'no data' : `${number(day.energyKwh)} estimated kWh`}, ${number(day.coveragePct, 0)}% coverage`"
            aria-controls="energy-day-detail"
            @click="selectedDate = day.date"
          >
            <span
              class="energy-day-bar"
              :class="{ missing: day.energyKwh == null }"
              ><span
                v-if="day.energyKwh != null"
                :style="{
                  height: `${Math.max(day.energyKwh > 0 ? 2 : 0, (100 * day.energyKwh) / maxDayEnergy)}%`,
                }"
              ></span
            ></span>
            <strong>{{ number(day.energyKwh) }}</strong
            ><span>{{ dateLabel(day.date) }}</span
            ><small
              >{{ number(day.coveragePct, 0) }}% of
              {{ number(day.expectedSeconds / 3600, 1) }} h</small
            >
          </button>
        </div>
      </section>
      <section
        v-if="selectedDay"
        id="energy-day-detail"
        class="energy-section"
        aria-labelledby="energy-day-title"
      >
        <div class="energy-section-heading">
          <h3 id="energy-day-title">
            {{ dateLabel(selectedDay.date) }} · Hourly detail
          </h3>
          <span class="energy-muted"
            >{{ number(selectedDay.energyKwh) }} kWh ·
            {{ number(selectedDay.activeMinutes, 0) }} active min</span
          >
        </div>
        <div
          class="energy-hour-plot"
          role="img"
          :aria-label="`Hourly estimated consumption for ${dateLabel(selectedDay.date)}`"
          :style="{
            gridTemplateColumns: `repeat(${Math.max(1, selectedHours.length)}, minmax(0, 1fr))`,
          }"
        >
          <div
            v-for="hour in selectedHours"
            :key="hour.from"
            class="energy-hour"
            :class="{ missing: hour.energyKwh == null }"
            :title="`${hourLabel(hour.from)}: ${hour.energyKwh == null ? 'no data' : `${number(hour.energyKwh, 3)} kWh`}; ${number(hour.coveragePct, 0)}% coverage`"
          >
            <span
              v-if="hour.energyKwh != null"
              :style="{
                height: `${Math.max(hour.energyKwh > 0 ? 1 : 0, (100 * hour.energyKwh) / maxHourEnergy)}%`,
              }"
            ></span>
          </div>
        </div>
        <div class="energy-table">
          <table>
            <caption class="energy-muted">
              {{
                dashboard.asset.timezone
              }}
              · Active at
              {{
                dashboard.asset.activeThresholdW
              }}
              W or above
            </caption>
            <thead>
              <tr>
                <th>Hour</th>
                <th>Estimated energy</th>
                <th>Average power</th>
                <th>Peak power</th>
                <th>Active</th>
                <th>Coverage</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="hour in selectedHours" :key="hour.from">
                <td>{{ hourLabel(hour.from) }}</td>
                <td>{{ number(hour.energyKwh, 3) }} kWh</td>
                <td>{{ number(hour.averagePowerW, 0) }} W</td>
                <td>{{ number(hour.peakPowerW, 0) }} W</td>
                <td>{{ number(hour.activeMinutes, 0) }} min</td>
                <td>{{ number(hour.coveragePct, 0) }}%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <p
        v-if="
          dashboard.invalidReadings ||
          dashboard.rejectedReadings ||
          dashboard.conflictingReadings
        "
        class="energy-muted"
      >
        Quality checks:
        {{ dashboard.invalidReadings + dashboard.rejectedReadings }} invalid
        readings; {{ dashboard.conflictingReadings }} conflicting duplicates.
      </p>
    </template>
  </section>
</template>

<style scoped>
.energy-page {
  min-width: 0;
  display: grid;
  gap: 20px;
  color: var(--text, #101828);
  letter-spacing: 0;
}
.energy-header,
.energy-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.energy-header h2 {
  font-size: 24px;
  margin: 5px 0;
}
.energy-page .eyebrow {
  margin: 0;
}
.energy-controls {
  display: flex;
  align-items: end;
  flex-wrap: wrap;
  gap: 16px;
  padding-bottom: 20px;
  border-bottom: 1px solid #d8e0ec;
}
.energy-controls label {
  display: grid;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  min-width: 180px;
}
.energy-controls select {
  font: inherit;
  padding: 10px 12px;
  border: 1px solid #c6d1df;
  border-radius: 6px;
  min-height: 42px;
  background: #fff;
  color: #101828;
}
.energy-page button {
  font: inherit;
  cursor: pointer;
}
.energy-page button:focus-visible {
  outline: 3px solid #2563eb;
  outline-offset: 2px;
}
.energy-muted {
  color: #64748b;
  font-size: 13px;
  line-height: 1.6;
  margin: 0;
}
.energy-notice {
  margin: 0;
  padding: 14px;
  border-left: 3px solid #bd8716;
  background: #fff8e6;
  color: #694b0b;
  line-height: 1.6;
}
.energy-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 24px;
  margin: 0;
  padding: 8px 0 20px;
  border-bottom: 1px solid #d8e0ec;
}
.energy-summary div {
  min-width: 0;
}
.energy-summary dt {
  color: #64748b;
  font-size: 13px;
}
.energy-summary dd {
  font-size: 28px;
  font-weight: 750;
  margin: 8px 0 0;
  overflow-wrap: anywhere;
}
.energy-summary small {
  font-size: 14px;
  font-weight: 500;
}
.energy-section {
  min-width: 0;
  padding-top: 4px;
}
.energy-section h3 {
  font-size: 18px;
  margin: 0;
}
.energy-days {
  display: flex;
  gap: 8px;
  overflow: auto;
  padding: 16px 3px 8px;
}
.energy-day {
  flex: 1 0 108px;
  min-width: 0;
  max-width: 132px;
  display: grid;
  gap: 6px;
  text-align: left;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  padding: 8px;
  color: inherit;
}
.energy-day[aria-pressed='true'] {
  border-color: #2563eb;
  background: #edf3ff;
}
.energy-day > span:not(.energy-day-bar) {
  font-size: 12px;
  white-space: nowrap;
}
.energy-day small {
  font-size: 11px;
  color: #64748b;
}
.energy-day-bar {
  height: 105px;
  display: flex;
  align-items: end;
  border-bottom: 1px solid #d8e0ec;
}
.energy-day-bar > span {
  display: block;
  width: 100%;
  background: #2563eb;
  border-radius: 3px 3px 0 0;
}
.missing {
  background: repeating-linear-gradient(
    135deg,
    transparent,
    transparent 7px,
    #a4adba22 7px,
    #a4adba22 9px
  );
}
.energy-hour-plot {
  display: grid;
  align-items: end;
  height: 160px;
  gap: 3px;
  border-bottom: 1px solid #a4adba;
  padding-top: 12px;
  margin: 16px 0;
}
.energy-hour {
  height: 100%;
  display: flex;
  align-items: end;
}
.energy-hour > span {
  display: block;
  width: 100%;
  background: #159a7a;
  border-radius: 2px 2px 0 0;
}
.energy-table {
  overflow: auto;
  margin-top: 16px;
}
.energy-table table {
  border-collapse: collapse;
  width: 100%;
  font-size: 13px;
  white-space: nowrap;
}
.energy-table caption {
  text-align: left;
  margin-bottom: 10px;
}
.energy-table th,
.energy-table td {
  padding: 12px 10px;
  text-align: right;
  border-bottom: 1px solid #d8e0ec;
}
.energy-table th:first-child,
.energy-table td:first-child {
  text-align: left;
}
.energy-table th {
  font-weight: 600;
  color: #64748b;
}
.energy-page button:disabled {
  opacity: 0.6;
  cursor: wait;
}
.energy-summary div {
  display: block;
}
.energy-summary dd {
  text-align: left;
  color: inherit;
}
:global(.theme-dark .energy-page) {
  color: #edf2f7;
}
:global(.theme-dark .energy-muted),
:global(.theme-dark .energy-summary dt),
:global(.theme-dark .energy-day small),
:global(.theme-dark .energy-table th) {
  color: #a7b5c7;
}
:global(.theme-dark .energy-controls select) {
  background: #18212e;
  border-color: #3c495b;
  color: #edf2f7;
}
:global(.theme-dark .energy-day[aria-pressed='true']) {
  background: #172c49;
}
:global(.theme-dark .energy-notice) {
  background: #342b18;
  color: #f1dca8;
}
:global(.theme-dark .energy-controls),
:global(.theme-dark .energy-summary),
:global(.theme-dark .energy-table td),
:global(.theme-dark .energy-table th) {
  border-color: #394657;
}
@media (max-width: 900px) {
  .energy-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 20px;
  }
  .energy-controls label {
    min-width: 140px;
    flex: 1;
  }
  .energy-section-heading {
    align-items: start;
    flex-wrap: wrap;
  }
  .energy-summary dd {
    font-size: 24px;
  }
}
@media (max-width: 420px) {
  .energy-header h2 {
    font-size: 21px;
  }
  .energy-controls label {
    min-width: 0;
    flex-basis: 100%;
  }
  .energy-summary dd {
    font-size: 22px;
  }
  .energy-hour-plot {
    gap: 2px;
  }
}
</style>
