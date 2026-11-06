<script setup lang="ts">
import { computed, ref } from 'vue';
import { buildTimeSeriesGeometry, timeSeriesStatistics, TIME_SERIES_PLOT, type TimeSeriesPoint } from './time-series-chart';

const props = withDefaults(defineProps<{
  label: string;
  unit: string;
  points: TimeSeriesPoint[];
  from: number;
  to: number;
  rangeLabel: string;
  statistics?: boolean;
  decimals?: number;
}>(), { statistics: true, decimals: 1 });

const hovered = ref<TimeSeriesPoint | null>(null);
const geometry = computed(() => buildTimeSeriesGeometry(props.points, props.from, props.to));
const summary = computed(() => props.statistics ? timeSeriesStatistics(geometry.value.rows) : null);
const timeFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const axisFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
const formatValue = (value: number) => new Intl.NumberFormat(undefined, { minimumFractionDigits: props.decimals, maximumFractionDigits: props.decimals }).format(value);
const formatTime = (value: string) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timeFormatter.format(timestamp) : 'Unknown time';
};
const axisStart = computed(() => axisFormatter.format(props.from));
const axisEnd = computed(() => axisFormatter.format(props.to));
const svgLine = (points: typeof geometry.value.rows) => points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
const pointLabel = (point: TimeSeriesPoint) => `${props.label} ${formatValue(point.value)} ${props.unit} at ${formatTime(point.observedAt)}`;
</script>

<template>
  <div v-if="geometry.rows.length" class="time-series-chart">
    <div class="time-series-plot">
      <svg viewBox="0 0 360 180" role="group" :aria-label="`${label} history, ${rangeLabel}`">
        <line v-for="(tick, index) in geometry.ticks" :key="`grid-${tick}`" :x1="TIME_SERIES_PLOT.left" :y1="TIME_SERIES_PLOT.top + index * ((TIME_SERIES_PLOT.bottom - TIME_SERIES_PLOT.top) / 2)" :x2="TIME_SERIES_PLOT.right" :y2="TIME_SERIES_PLOT.top + index * ((TIME_SERIES_PLOT.bottom - TIME_SERIES_PLOT.top) / 2)" class="time-series-grid" />
        <text :x="TIME_SERIES_PLOT.left - 6" y="18" text-anchor="end">{{ formatValue(geometry.ticks[0]) }}</text>
        <text :x="TIME_SERIES_PLOT.left - 6" y="137" text-anchor="end">{{ formatValue(geometry.ticks[2]) }}</text>
        <path v-for="segment in geometry.segments" :key="`${segment[0].observedAt}-${segment.at(-1)?.observedAt}`" :d="svgLine(segment)" class="time-series-line chart-line-segment" />
        <circle v-for="point in geometry.markers" :key="`${point.observedAt}-${point.value}`" :cx="point.x" :cy="point.y" r="1.8" class="time-series-point chart-point" tabindex="0" :aria-label="pointLabel(point)" @pointerenter="hovered = point" @pointerleave="hovered = null" @focus="hovered = point" @blur="hovered = null"><title>{{ pointLabel(point) }}</title></circle>
        <line :x1="TIME_SERIES_PLOT.left" y1="136" :x2="TIME_SERIES_PLOT.right" y2="136" class="time-series-axis" />
        <text :x="TIME_SERIES_PLOT.left" y="162">{{ axisStart }}</text>
        <text :x="TIME_SERIES_PLOT.right" y="162" text-anchor="end">{{ axisEnd }}</text>
      </svg>
      <div v-if="hovered" class="time-series-tooltip chart-tooltip" role="status"><strong>{{ formatValue(hovered.value) }} {{ unit }}</strong><time>{{ formatTime(hovered.observedAt) }}</time></div>
    </div>
    <div v-if="summary" class="time-series-summary chart-summary" :aria-label="`${label} summary for ${rangeLabel}`">
      <div><span>Min</span><strong>{{ formatValue(summary.minimum) }} <small>{{ unit }}</small></strong></div>
      <div><span>Median</span><strong>{{ formatValue(summary.median) }} <small>{{ unit }}</small></strong></div>
      <div><span>Max</span><strong>{{ formatValue(summary.maximum) }} <small>{{ unit }}</small></strong></div>
      <span class="time-series-count">{{ summary.count }} samples</span>
    </div>
    <p class="time-series-note">Markers and trends use recorded samples only. Lines connect nearby readings; long gaps stay unconnected. Dense samples are reduced for display while summaries use all points.</p>
  </div>
  <p v-else class="time-series-empty">No {{ label.toLowerCase() }} history in this range.</p>
</template>

<style scoped>
.time-series-chart{display:grid;gap:7px;min-width:0;width:100%;max-width:720px;margin-inline:auto}.time-series-plot{position:relative}.time-series-plot svg{display:block;width:100%;height:auto;margin-top:8px;overflow:visible}.time-series-axis{stroke:var(--eg-border,#d8e0ec);stroke-width:1.25}.time-series-grid{stroke:var(--eg-border,#d8e0ec);stroke-width:1;stroke-dasharray:3 5;opacity:.75}.time-series-line{fill:none;stroke:var(--eg-blue,#2863e6);stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}.time-series-point{fill:var(--eg-blue,#2863e6);stroke:var(--eg-surface,#fff);stroke-width:1;cursor:crosshair;vector-effect:non-scaling-stroke}.time-series-point:focus{outline:none;stroke:var(--eg-text,#111827);stroke-width:2.2}.time-series-plot svg text{fill:var(--eg-muted,#58677e);font-size:11px}.time-series-tooltip{position:absolute;z-index:1;top:8px;right:8px;display:grid;gap:2px;border:1px solid var(--eg-border,#d8e0ec);border-radius:8px;background:var(--eg-surface,#fff);box-shadow:0 4px 16px rgb(15 23 42 / 12%);padding:7px 10px;font-size:12px;pointer-events:none}.time-series-tooltip strong{color:var(--eg-text,#111827);font-size:14px}.time-series-tooltip time{color:var(--eg-muted,#58677e)}.time-series-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin-top:4px}.time-series-summary>div{display:grid;gap:3px;min-width:0;border:1px solid var(--eg-border,#d8e0ec);border-radius:8px;background:var(--eg-surface-soft,#f5f8fc);padding:7px 9px}.time-series-summary span{color:var(--eg-muted,#58677e);font-size:12px}.time-series-summary strong{color:var(--eg-text,#111827);font-size:15px;white-space:nowrap}.time-series-summary small{color:var(--eg-muted,#58677e);font-size:11px;font-weight:600}.time-series-count{grid-column:1/-1}.time-series-note,.time-series-empty{margin:0;color:var(--eg-muted,#58677e);font-size:11px}@media(max-width:560px){.time-series-summary strong{font-size:13px}}
</style>
