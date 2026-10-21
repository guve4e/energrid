import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ForecastDayDetail from './ForecastDayDetail.vue';
import type { ForecastDay, ForecastDayDetails } from './forecast-types';

export const day: ForecastDay = {
  date: '2026-10-10',
  tempMin: 12,
  tempMax: 18,
  rainTotalMm: 30,
  rainChanceMax: 80,
  gustMaxKmh: 31,
  weatherCode: 63,
  condition: 'Moderate rain',
  sourceModel: 'ncep_gfs_seamless',
  agreement: 'disagreement',
  selectionReason:
    'Models disagree for this date; showing the more cautious daily forecast.',
};
export const detail: ForecastDayDetails = {
  date: day.date,
  timezone: 'Europe/Sofia',
  startsAt: '2026-10-09T21:00:00Z',
  endsAt: '2026-10-10T21:00:00Z',
  sourceProvider: 'open-meteo',
  sourceModel: 'ncep_gfs_seamless',
  coverage: {
    status: 'partial',
    availableHours: 2,
    expectedHours: 24,
    precipitationHours: 2,
  },
  hours: [
    {
      time: '2026-10-10T09:00:00Z',
      temperature: 16,
      feelsLike: 14,
      humidity: 70,
      pressure: 1008,
      windKmh: 20,
      gustKmh: 31,
      precipitationMm: 4,
      rainChance: 80,
      condition: 'Moderate rain',
    },
    {
      time: '2026-10-10T10:00:00Z',
      temperature: 17,
      feelsLike: 15,
      humidity: 80,
      pressure: 1010,
      windKmh: 18,
      gustKmh: 26,
      precipitationMm: 0,
      rainChance: 40,
      condition: 'Overcast',
    },
  ],
  statistics: {
    wetHours: 1,
    maxHourlyMm: 4,
    peakRainAt: '2026-10-10T09:00:00Z',
    peakGustAt: '2026-10-10T09:00:00Z',
    meanHumidityPct: 75,
    meanPressureHpa: 1009,
    rainWindows: [
      { startsAt: '2026-10-10T09:00:00Z', endsAt: '2026-10-10T10:00:00Z' },
    ],
  },
  models: [
    { ...day, provider: 'open-meteo', model: 'ncep_gfs_seamless' },
    { ...day, rainTotalMm: 3, provider: 'open-meteo', model: 'icon_seamless' },
  ],
};

describe('selected forecast day', () => {
  it('shows the selected date, daily totals, local hourly parameters and source comparison', () => {
    const wrapper = mount(ForecastDayDetail, { props: { day, detail } });
    expect(wrapper.get('#selected-day-title').text()).toContain('October 10');
    expect(wrapper.text()).toContain('Cautious · models differ');
    expect(wrapper.text()).toContain('30.0 L/m²');
    expect(wrapper.text()).toContain('12:00');
    expect(wrapper.text()).toContain('75%');
    expect(wrapper.text()).toContain('1009 hPa');
    expect(wrapper.text()).toContain('Partial hourly forecast');
    expect(wrapper.text()).toContain('NOAA GFS · shown');
    expect(wrapper.text()).toContain('DWD ICON');
    expect(wrapper.findAll('rect[fill="#2563eb"]')).toHaveLength(2);
    wrapper.unmount();
  });

  it('switches hourly measurements and keeps all parameters available', async () => {
    const wrapper = mount(ForecastDayDetail, { props: { day, detail } });
    await wrapper.get('button:nth-child(2)').trigger('click');
    expect(wrapper.get('svg').attributes('aria-label')).toContain(
      'temperature forecast',
    );
    expect(wrapper.findAll('path')).toHaveLength(2);
    expect(wrapper.get('button:nth-child(2)').attributes('aria-pressed')).toBe(
      'true',
    );
    await wrapper.get('button:nth-child(3)').trigger('click');
    expect(wrapper.get('svg').attributes('aria-label')).toContain(
      'wind forecast',
    );
    expect(wrapper.text()).toContain('Humidity %');
    wrapper.unmount();
  });

  it('removes previous hours and statistics when moving to a daily-only day', async () => {
    const wrapper = mount(ForecastDayDetail, { props: { day, detail } });
    const dailyOnlyProps = {
      day: { ...day, date: '2026-10-15' },
      detail: undefined,
    };
    await wrapper.setProps(
      dailyOnlyProps as Parameters<typeof wrapper.setProps>[0],
    );
    expect(wrapper.text()).toContain('October 15');
    expect(wrapper.text()).toContain('Hourly details unavailable');
    expect(wrapper.text()).not.toContain('1009 hPa');
    expect(wrapper.find('svg').exists()).toBe(false);
    wrapper.unmount();
  });

  it('keeps missing rainfall distinct from dry hours and avoids drawing a false zero', () => {
    const unavailable = {
      ...detail,
      hours: detail.hours.map((h) => ({ ...h, precipitationMm: null })),
      statistics: {
        ...detail.statistics,
        wetHours: null,
        maxHourlyMm: null,
        peakRainAt: null,
        rainWindows: [],
      },
      coverage: { ...detail.coverage, precipitationHours: 0 },
    };
    const wrapper = mount(ForecastDayDetail, {
      props: { day, detail: unavailable },
    });
    expect(wrapper.text()).toContain('rain values are unavailable');
    expect(wrapper.text()).toContain('Rain windows: Unavailable.');
    expect(wrapper.find('svg').exists()).toBe(false);
    wrapper.unmount();
  });

  it('breaks lines at missing hours instead of connecting across gaps', async () => {
    const gapped = {
      ...detail,
      hours: [
        detail.hours[0],
        { ...detail.hours[1], time: '2026-10-10T12:00:00Z' },
      ],
    };
    const wrapper = mount(ForecastDayDetail, {
      props: { day, detail: gapped },
    });
    await wrapper.get('button:nth-child(2)').trigger('click');
    const path = wrapper.get('path').attributes('d') || '';
    expect(path.match(/M/g)).toHaveLength(2);
    expect(path).not.toContain('L');
    wrapper.unmount();
  });
});
