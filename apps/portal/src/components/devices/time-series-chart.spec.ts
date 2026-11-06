import { describe, expect, it } from 'vitest';
import { buildTimeSeriesGeometry, timeSeriesStatistics, validTimeSeriesPoints, type TimeSeriesPoint } from './time-series-chart';

const point = (second: number, value: number): TimeSeriesPoint => ({ observedAt: new Date(1_800_000_000_000 + second * 1000).toISOString(), value });

describe('shared numerical time-series geometry', () => {
  it('handles empty, single, constant, zero, negative and outlier samples safely', () => {
    expect(buildTimeSeriesGeometry([], 1_800_000_000_000, 1_800_000_060_000).rows).toEqual([]);
    expect(buildTimeSeriesGeometry([point(0, 0)], 1_800_000_000_000, 1_800_000_060_000).markers).toHaveLength(1);
    expect(buildTimeSeriesGeometry([point(0, -2), point(1, -2)], 1_800_000_000_000, 1_800_000_060_000).rows.every(row => Number.isFinite(row.y))).toBe(true);
    const stats = timeSeriesStatistics([point(0, -4), point(1, 0), point(2, 1000)]);
    expect(stats).toMatchObject({ minimum: -4, median: 0, maximum: 1000, count: 3 });
  });

  it('keeps gaps disconnected and filters malformed points without synthesizing samples', () => {
    const rows = [point(0, 1), point(1, 2), point(600, 3), { observedAt: 'invalid', value: 50 }, { observedAt: point(601, 4).observedAt, value: Number.NaN }];
    const geometry = buildTimeSeriesGeometry(rows, 1_800_000_000_000, 1_800_001_000_000);
    expect(geometry.rows).toHaveLength(3);
    expect(geometry.segments).toHaveLength(1);
    expect(geometry.segments[0].map(row => row.value)).toEqual([1, 2]);
    expect(validTimeSeriesPoints(rows)).toHaveLength(3);
  });

  it('keeps the same observation gap split in every display window', () => {
    const points = [point(0, 1), point(60, 2), point(1260, 3), point(1320, 4)];
    const start = 1_800_000_000_000;
    const windows = [
      { from: start - 60 * 60_000, to: start + 60 * 60_000 },
      { from: start - 12 * 60 * 60_000, to: start + 12 * 60 * 60_000 },
      { from: start - 3.5 * 24 * 60 * 60_000, to: start + 3.5 * 24 * 60 * 60_000 },
    ];

    for (const window of windows) {
      const geometry = buildTimeSeriesGeometry(points, window.from, window.to);
      expect(geometry.segments.map(segment => segment.map(sample => sample.observedAt))).toEqual([
        points.slice(0, 2).map(sample => sample.observedAt),
        points.slice(2).map(sample => sample.observedAt),
      ]);
    }
  });

  it('keeps a six-hour outage split in both 24-hour and seven-day views', () => {
    const points = [point(0, 1), point(15 * 60, 2), point(6 * 60 * 60 + 15 * 60, 3), point(6 * 60 * 60 + 30 * 60, 4)];
    const start = 1_800_000_000_000;
    const windows = [
      { from: start - 12 * 60 * 60_000, to: start + 12 * 60 * 60_000 },
      { from: start - 3.5 * 24 * 60 * 60_000, to: start + 3.5 * 24 * 60 * 60_000 },
    ];

    for (const window of windows) {
      const geometry = buildTimeSeriesGeometry(points, window.from, window.to);
      expect(geometry.segments.map(segment => segment.map(sample => sample.observedAt))).toEqual([
        points.slice(0, 2).map(sample => sample.observedAt),
        points.slice(2).map(sample => sample.observedAt),
      ]);
    }
  });

  it('connects legitimately slower regular samples using their observed cadence', () => {
    const points = [point(0, 1), point(15 * 60, 2), point(30 * 60, 3), point(45 * 60, 4)];
    const geometry = buildTimeSeriesGeometry(points, 1_800_000_000_000, 1_800_000_000_000 + 24 * 60 * 60_000);
    expect(geometry.segments).toHaveLength(1);
    expect(geometry.segments[0].map(sample => sample.observedAt)).toEqual(points.map(sample => sample.observedAt));
  });

  it('bounds dense markers while preserving actual timestamps and each pixel bucket extrema', () => {
    const points = Array.from({ length: 1200 }, (_, index) => point(index, index === 618 ? 5000 : Math.sin(index / 18)));
    const geometry = buildTimeSeriesGeometry(points, 1_800_000_000_000, 1_800_001_200_000);
    expect(geometry.rows).toHaveLength(1200);
    expect(geometry.markers.length).toBeLessThanOrEqual(148);
    expect(geometry.markers.some(row => row.value === 5000 && row.observedAt === points[618].observedAt)).toBe(true);
    expect(geometry.markers.every(row => points.some(original => original.observedAt === row.observedAt && original.value === row.value))).toBe(true);
  });

  it('contains no metric, device, protocol, transport or authorization policy', () => {
    expect(Object.keys(buildTimeSeriesGeometry([point(0, 1)], 1_800_000_000_000, 1_800_000_060_000))).toEqual(['rows', 'markers', 'segments', 'ticks']);
    expect(timeSeriesStatistics([point(0, 2), point(1, 4)])?.median).toBe(3);
  });
});
