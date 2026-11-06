import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import TimeSeriesChart from './TimeSeriesChart.vue';

describe('TimeSeriesChart', () => {
  it('renders a bounded sample trend, full-data summary and accessible unit metadata', () => {
    const start = Date.now() - 60 * 60_000;
    const points = Array.from({ length: 900 }, (_, index) => ({
      observedAt: new Date(start + index * 4_000).toISOString(),
      value: index === 450 ? 2500 : 100 + Math.sin(index / 20),
    }));
    const chart = mount(TimeSeriesChart, { props: {
      label: 'Power', unit: 'W', points, from: start, to: start + 60 * 60_000,
      rangeLabel: '1 hour', statistics: true, decimals: 1,
    } });
    expect(chart.find('svg').attributes('aria-label')).toBe('Power history, 1 hour');
    expect(chart.findAll('circle.time-series-point').length).toBeLessThanOrEqual(148);
    expect(chart.findAll('circle.time-series-point').some(point => /2,?500\.0 W/.test(point.attributes('aria-label') ?? ''))).toBe(true);
    expect(chart.find('.time-series-summary').text()).toMatch(/2,?500\.0 W/);
    expect(chart.text()).toContain('900 samples');
  });

  it('can render cumulative counters without implying min/median/max consumption statistics', () => {
    const chart = mount(TimeSeriesChart, { props: {
      label: 'Imported energy', unit: 'kWh', points: [
        { observedAt: new Date(Date.now() - 30_000).toISOString(), value: 12.345 },
        { observedAt: new Date().toISOString(), value: 12.346 },
      ], from: Date.now() - 60 * 60_000, to: Date.now(), rangeLabel: '1 hour', statistics: false, decimals: 3,
    } });
    expect(chart.text()).not.toContain('Median');
    expect(chart.findAll('circle title').some(title => title.text().includes('12.346 kWh'))).toBe(true);
  });

  it('renders a single zero-valued constant-series sample with finite geometry', () => {
    const now = Date.now();
    const chart = mount(TimeSeriesChart, { props: {
      label: 'Temperature', unit: '°C', points: [{ observedAt: new Date(now - 1_000).toISOString(), value: 0 }],
      from: now - 60_000, to: now, rangeLabel: '1 hour',
    } });
    expect(chart.findAll('circle.time-series-point')).toHaveLength(1);
    expect(chart.find('circle.time-series-point').attributes('cy')).toMatch(/^\d+(\.\d+)?$/);
    expect(chart.find('.time-series-summary').text()).toContain('0.0 °C');
  });
});
