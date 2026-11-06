export interface TimeSeriesPoint {
  observedAt: string;
  value: number;
}

export interface PositionedTimeSeriesPoint extends TimeSeriesPoint {
  timestamp: number;
  x: number;
  y: number;
}

export interface TimeSeriesStatistics {
  minimum: number;
  median: number;
  maximum: number;
  count: number;
}

export const TIME_SERIES_PLOT = { left: 54, right: 350, top: 22, bottom: 136 } as const;
const PIXEL_BUCKETS = 74;
const MARKER_LIMIT = PIXEL_BUCKETS * 2;
const MINIMUM_CONNECTED_GAP_MS = 5 * 60_000;
const GAP_CADENCE_MULTIPLIER = 3;

export function validTimeSeriesPoints(points: TimeSeriesPoint[]): TimeSeriesPoint[] {
  return points
    .filter(point => typeof point.value === 'number' && Number.isFinite(point.value) && Number.isFinite(Date.parse(point.observedAt)))
    .slice()
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
}

export function timeSeriesStatistics(points: TimeSeriesPoint[]): TimeSeriesStatistics | null {
  const values = validTimeSeriesPoints(points).map(point => point.value).sort((left, right) => left - right);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return {
    minimum: values[0],
    median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
    maximum: values[values.length - 1],
    count: values.length,
  };
}

function bounds(points: TimeSeriesPoint[]) {
  const values = points.map(point => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.12, Math.abs(max) * 0.01, 0.1);
  return { low: min - pad, high: max + pad };
}

function maximumConnectedGapMs(samples: TimeSeriesPoint[]): number {
  const intervals = samples.slice(1)
    .map((point, index) => Date.parse(point.observedAt) - Date.parse(samples[index].observedAt))
    .filter(interval => interval > 0)
    .sort((left, right) => left - right);
  if (!intervals.length) return MINIMUM_CONNECTED_GAP_MS;

  // The lower median prevents an isolated outage from inflating the expected sample cadence.
  const typicalInterval = intervals[Math.floor((intervals.length - 1) / 2)];
  return Math.max(MINIMUM_CONNECTED_GAP_MS, typicalInterval * GAP_CADENCE_MULTIPLIER);
}

function decimate(points: PositionedTimeSeriesPoint[]): PositionedTimeSeriesPoint[] {
  if (points.length <= MARKER_LIMIT) return points;
  const buckets = new Map<number, { min: PositionedTimeSeriesPoint; max: PositionedTimeSeriesPoint }>();
  for (const point of points) {
    const bucket = Math.max(0, Math.min(PIXEL_BUCKETS - 1, Math.floor((point.x - TIME_SERIES_PLOT.left) /
      (TIME_SERIES_PLOT.right - TIME_SERIES_PLOT.left) * PIXEL_BUCKETS)));
    const current = buckets.get(bucket);
    if (!current) buckets.set(bucket, { min: point, max: point });
    else {
      if (point.value < current.min.value) current.min = point;
      if (point.value > current.max.value) current.max = point;
    }
  }
  const selected = new Set<PositionedTimeSeriesPoint>();
  for (const bucket of buckets.values()) {
    selected.add(bucket.min);
    selected.add(bucket.max);
  }
  return [...selected].sort((left, right) => left.timestamp - right.timestamp);
}

/** Builds display geometry from actual samples; cadence-based gaps remain separate paths without interpolation. */
export function buildTimeSeriesGeometry(
  points: TimeSeriesPoint[],
  from: number,
  to: number,
) {
  const samples = validTimeSeriesPoints(points);
  const maximumGap = maximumConnectedGapMs(samples);
  const rows = samples.filter(point => Date.parse(point.observedAt) >= from && Date.parse(point.observedAt) <= to);
  if (!rows.length || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return { rows: [] as PositionedTimeSeriesPoint[], markers: [] as PositionedTimeSeriesPoint[], segments: [] as PositionedTimeSeriesPoint[][], ticks: [0, 0.5, 1] };
  }
  const { low, high } = bounds(rows);
  const positioned = rows.map(point => {
    const timestamp = Date.parse(point.observedAt);
    return {
      ...point,
      timestamp,
      x: TIME_SERIES_PLOT.left + ((timestamp - from) / (to - from)) * (TIME_SERIES_PLOT.right - TIME_SERIES_PLOT.left),
      y: TIME_SERIES_PLOT.bottom - ((point.value - low) / (high - low)) * (TIME_SERIES_PLOT.bottom - TIME_SERIES_PLOT.top),
    };
  });
  const segments: PositionedTimeSeriesPoint[][] = [];
  for (const point of positioned) {
    const current = segments.at(-1);
    if (!current || point.timestamp - current.at(-1)!.timestamp > maximumGap) segments.push([point]);
    else current.push(point);
  }
  return {
    rows: positioned,
    markers: decimate(positioned),
    segments: segments.filter(segment => segment.length > 1),
    ticks: [high, (low + high) / 2, low],
  };
}
