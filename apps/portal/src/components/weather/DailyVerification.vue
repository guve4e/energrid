<script setup lang="ts">
import { computed, ref } from 'vue';
import { weatherModelName } from './weather-model-label';

interface DailyScore {
  provider: string;
  modelVersion: string;
  metric: string;
  leadDays: number;
  observationSource: string;
  samples: number;
  verifiedDays: number;
  mae: number | null;
  rmse: number | null;
  bias: number | null;
}
interface DailyResult {
  date: string;
  provider: string;
  modelVersion: string;
  metric: string;
  leadDays: number;
  issuedAt: string;
  predicted: number;
  actual: number;
  absoluteError: number;
  observationSource: string;
  sourceModel?: string;
  agreement?: string;
}
export interface DailyPerformance {
  status: string;
  summary: DailyScore[];
  recent: DailyResult[];
  pending?: { scheduled: number; awaitingObservations: number };
}
export interface ObservationCollection {
  status: string;
  note: string;
  source: string | null;
  lastObservedAt?: string | null;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  availableMetrics?: string[];
  granularity?: 'hourly' | 'daily';
  nextCollectionAt?: string;
  lastReportDate?: string | null;
  station?: { name: string; id: string; distanceKm: number };
}
const props = defineProps<{
  daily?: DailyPerformance;
  collection?: ObservationCollection;
}>();
const lead = ref('all');
const metric = ref('precipitation_mm');
const matches = (row: { metric: string; leadDays: number }) =>
  row.metric === metric.value &&
  (lead.value === 'all' || row.leadDays === Number(lead.value));
const scores = computed(() => props.daily?.summary.filter(matches) ?? []);
const recent = computed(() => props.daily?.recent.filter(matches) ?? []);
const number = (n: number | null | undefined) =>
  n == null || !Number.isFinite(Number(n)) ? '-' : Number(n).toFixed(1);
const unit = computed(() =>
  metric.value === 'precipitation_mm'
    ? 'L/m²'
    : metric.value.startsWith('temperature_')
      ? '°C'
      : 'km/h',
);
const statusName = computed(
  () =>
    ({
      'configuration-required': 'Measurement source not connected',
      ready: 'Waiting for first station collection',
      available: 'Station observations received',
      'no-observations': 'Station returned no usable observations',
      unavailable: 'Station collection unavailable',
      manual: 'Private station adapter',
      disabled: 'Measurement collection disabled',
      'reporting-period-unverified': 'Daily reporting period not verified',
    })[props.collection?.status ?? ''] ?? 'Measurement source unknown',
);
</script>

<template>
  <section
    class="daily-verification"
    aria-labelledby="daily-verification-title"
  >
    <h3 id="daily-verification-title">Forecast versus measured weather</h3>
    <div v-if="collection" class="observation-status" role="status">
      <strong>{{ statusName }}</strong>
      <p v-if="collection.station">
        {{ collection.station.name }} · station {{ collection.station.id }} ·
        {{ number(collection.station.distanceKm) }} km from forecast location
      </p>
      <p>{{ collection.note }}</p>
      <p v-if="collection.availableMetrics">
        Measurements received:
        {{
          collection.availableMetrics
            .map(
              (m) =>
                ({
                  precipitation_mm: 'precipitation',
                  gust_kmh: 'gusts',
                  temperature_c: 'temperature',
                  temperature_min_c: 'minimum temperature',
                  temperature_max_c: 'maximum temperature',
                })[m] || m,
            )
            .join(', ') || 'none'
        }}
      </p>
      <p v-if="collection.lastObservedAt">
        Latest measurement:
        {{ new Date(collection.lastObservedAt).toLocaleString() }}
      </p>
      <p v-if="collection.lastAttemptAt">
        Last collection attempt:
        {{ new Date(collection.lastAttemptAt).toLocaleString() }}
      </p>
      <p v-if="collection.nextCollectionAt">
        Next collection:
        {{ new Date(collection.nextCollectionAt).toLocaleString() }}
      </p>
      <p v-if="collection.lastReportDate">
        Latest daily report: {{ collection.lastReportDate }}
      </p>
    </div>
    <p v-if="daily?.status === 'migration-required'" role="status">
      Daily forecast storage needs initialization before recording can start.
    </p>
    <template v-else-if="daily">
      <div class="verification-filters">
        <label
          >Measurement<select
            v-model="metric"
            aria-label="Verification measurement"
          >
            <option value="precipitation_mm">Daily precipitation · L/m²</option>
            <option value="gust_kmh">Daily peak gust · km/h</option>
            <option value="temperature_min_c">
              Daily minimum temperature · °C
            </option>
            <option value="temperature_max_c">
              Daily maximum temperature · °C
            </option>
          </select></label
        >
        <label
          >Forecast made<select v-model="lead" aria-label="Forecast lead days">
            <option value="all">All lead days</option>
            <option v-for="day in 10" :key="day" :value="String(day)">
              {{ day }} {{ day === 1 ? 'day' : 'days' }} before
            </option>
          </select></label
        >
      </div>
      <p v-if="!scores.length" class="muted" role="status">
        No verified daily results for this selection yet. Incomplete measurement
        days remain unscored.
      </p>
      <div v-else class="verification-table">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Days ahead</th>
              <th>Verified days</th>
              <th>Saved forecasts</th>
              <th>Average error · {{ unit }}</th>
              <th>RMSE · {{ unit }}</th>
              <th>Bias · {{ unit }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in scores"
              :key="`${row.provider}-${row.modelVersion}-${row.leadDays}-${row.observationSource}`"
            >
              <td>
                {{ weatherModelName(row.modelVersion)
                }}<small>{{ row.observationSource }}</small>
              </td>
              <td>{{ row.leadDays }}</td>
              <td>
                {{ row.verifiedDays
                }}<small v-if="row.verifiedDays < 30">Limited evidence</small>
              </td>
              <td>{{ row.samples }}</td>
              <td>{{ number(row.mae) }}</td>
              <td>{{ number(row.rmse) }}</td>
              <td>{{ number(row.bias) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <template v-if="recent.length">
        <h4>Recent verified days</h4>
        <div class="verification-table">
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>Model</th>
                <th>Days ahead</th>
                <th>Predicted · {{ unit }}</th>
                <th>Measured · {{ unit }}</th>
                <th>Error · {{ unit }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in recent"
                :key="`${row.date}-${row.provider}-${row.modelVersion}-${row.leadDays}-${row.observationSource}`"
              >
                <td>
                  {{ row.date
                  }}<small
                    >Issued {{ new Date(row.issuedAt).toLocaleString() }}</small
                  >
                </td>
                <td>
                  {{ weatherModelName(row.modelVersion)
                  }}<small v-if="row.sourceModel"
                    >{{ weatherModelName(row.sourceModel)
                    }}<template v-if="row.agreement === 'disagreement'">
                      · Cautious choice</template
                    ></small
                  ><small>{{ row.observationSource }}</small>
                </td>
                <td>{{ row.leadDays }}</td>
                <td>{{ number(row.predicted) }}</td>
                <td>{{ number(row.actual) }}</td>
                <td>{{ number(row.absoluteError) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <p v-if="daily.pending" class="muted">
        {{ daily.pending.scheduled }} future daily predictions ·
        {{ daily.pending.awaitingObservations }} awaiting complete observations
      </p>
    </template>
  </section>
</template>

<style scoped>
.daily-verification {
  display: grid;
  gap: 14px;
  min-width: 0;
}
.daily-verification h3,
.daily-verification h4,
.daily-verification p {
  margin: 0;
}
.observation-status {
  border-left: 3px solid #3579be;
  padding: 8px 14px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.observation-status p,
.muted {
  color: #64748b;
  font-size: 13px;
}
.verification-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.verification-filters label {
  display: grid;
  gap: 6px;
  color: #475569;
  font-size: 13px;
  min-width: 0;
  flex: 0 1 260px;
}
.verification-filters select {
  width: 100%;
  min-width: 0;
  min-height: 42px;
  padding: 9px 12px;
  border: 1px solid #d8e0ec;
  border-radius: 6px;
  background: #fff;
  color: #172033;
  font: inherit;
}
.verification-table {
  overflow-x: auto;
  max-width: 100%;
}
table {
  width: 100%;
  min-width: 760px;
  border-collapse: collapse;
  text-align: left;
  font-size: 13px;
}
th,
td {
  padding: 12px 10px;
  border-bottom: 1px solid #d8e0ec;
  vertical-align: top;
}
small {
  display: block;
  color: #64748b;
  font-size: 12px;
  margin-top: 4px;
  overflow-wrap: anywhere;
}
th {
  font-weight: 700;
}
.muted {
  line-height: 1.6;
}
@media (max-width: 600px) {
  .verification-filters label {
    flex: 1 1 100%;
  }
}
</style>
