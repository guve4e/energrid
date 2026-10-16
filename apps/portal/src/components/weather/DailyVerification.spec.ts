import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import DailyVerification from './DailyVerification.vue';
import { weatherModelName } from './weather-model-label';

const score = {
  provider: 'energrid',
  modelVersion: 'daily-cautious:weather-v1',
  metric: 'precipitation_mm',
  leadDays: 3,
  observationSource: 'station',
  samples: 24,
  verifiedDays: 1,
  mae: 2.2,
  rmse: 2.2,
  bias: -2.2,
};
const result = {
  ...score,
  date: '2026-10-10',
  issuedAt: '2026-10-07T10:00:00Z',
  predicted: 5,
  actual: 2.8,
  absoluteError: 2.2,
  sourceModel: 'icon_seamless',
  agreement: 'disagreement',
};
let wrapper: ReturnType<typeof mount> | undefined;
afterEach(() => wrapper?.unmount());
describe('daily forecast verification view', () => {
  it('shows that daily reporting periods remain unverified without inventing a measurement timestamp', () => {
    wrapper = mount(DailyVerification, {
      props: {
        collection: {
          status: 'reporting-period-unverified',
          source: 'station',
          note: 'Stored reports remain unscored.',
          lastReportDate: '2026-10-14',
          availableMetrics: ['precipitation_mm', 'temperature_min_c'],
        },
      },
    });
    expect(wrapper.text()).toContain('Daily reporting period not verified');
    expect(wrapper.text()).toContain('Latest daily report: 2026-10-14');
    expect(wrapper.text()).not.toContain('Latest measurement:');
  });
  it('filters and displays daily minimum temperature with Celsius units and negative values', async () => {
    wrapper = mount(DailyVerification, {
      props: {
        daily: {
          status: 'available',
          summary: [{ ...score, metric: 'temperature_min_c', mae: 1 }],
          recent: [
            {
              ...result,
              metric: 'temperature_min_c',
              predicted: -5,
              actual: -4,
              absoluteError: 1,
            },
          ],
        },
      },
    });
    await wrapper
      .get('[aria-label="Verification measurement"]')
      .setValue('temperature_min_c');
    expect(wrapper.text()).toContain('Predicted · °C');
    expect(wrapper.text()).toContain('-5.0');
    expect(wrapper.text()).toContain('-4.0');
  });
  it('makes explicitly disabled external collection visible', () => {
    wrapper = mount(DailyVerification, {
      props: {
        collection: {
          status: 'disabled',
          source: null,
          note: 'Forecast recording continues.',
        },
      },
    });
    expect(wrapper.text()).toContain('Measurement collection disabled');
  });
  it('shows predicted versus measured amounts and distinguishes policy from its source model', () => {
    wrapper = mount(DailyVerification, {
      props: {
        daily: { status: 'available', summary: [score], recent: [result] },
      },
    });
    expect(wrapper.text()).toContain('Energrid daily selection');
    expect(wrapper.text()).toContain('DWD ICON');
    expect(wrapper.text()).toContain('Cautious choice');
    expect(wrapper.text()).toContain('5.0');
    expect(wrapper.text()).toContain('2.8');
    expect(wrapper.text()).toContain('2.2');
    expect(wrapper.text()).toContain('L/m²');
    expect(wrapper.text()).toContain('Limited evidence');
  });
  it('filters both summaries and recent evidence by measurement and lead day without a page reload', async () => {
    const gustScore = {
      ...score,
      metric: 'gust_kmh',
      leadDays: 7,
      modelVersion: 'ncep_gfs_seamless:weather-daily-v1',
    };
    wrapper = mount(DailyVerification, {
      props: {
        daily: {
          status: 'available',
          summary: [score, gustScore],
          recent: [
            result,
            { ...result, ...gustScore, predicted: 31, actual: 29 },
          ],
        },
      },
    });
    expect(wrapper.text()).not.toContain('NOAA GFS');
    await wrapper
      .get('[aria-label="Verification measurement"]')
      .setValue('gust_kmh');
    expect(wrapper.text()).toContain('NOAA GFS');
    expect(wrapper.text()).not.toContain('Energrid daily selection');
    expect(wrapper.text()).toContain('km/h');
    await wrapper.get('[aria-label="Forecast lead days"]').setValue('3');
    expect(wrapper.text()).toContain('No verified daily results');
    expect(wrapper.findAll('table')).toHaveLength(0);
    await wrapper.get('[aria-label="Forecast lead days"]').setValue('7');
    expect(wrapper.findAll('table')).toHaveLength(2);
  });
  it('uses distinct verified days, not saved snapshots, to flag limited evidence and keeps zero valid', () => {
    wrapper = mount(DailyVerification, {
      props: {
        daily: {
          status: 'available',
          summary: [
            {
              ...score,
              samples: 300,
              verifiedDays: 2,
              mae: 0,
              rmse: 0,
              bias: 0,
            },
          ],
          recent: [{ ...result, predicted: 0, actual: 0, absoluteError: 0 }],
        },
      },
    });
    expect(wrapper.text()).toContain('Limited evidence');
    expect(wrapper.text()).toContain('0.0');
    expect(wrapper.text()).not.toContain('NaN');
  });
  it('explains missing station configuration without claiming measured accuracy', () => {
    wrapper = mount(DailyVerification, {
      props: {
        collection: {
          status: 'configuration-required',
          source: null,
          note: 'No measured source is connected.',
        },
        daily: {
          status: 'awaiting-observations',
          summary: [],
          recent: [],
          pending: { scheduled: 12, awaitingObservations: 4 },
        },
      },
    });
    expect(wrapper.text()).toContain('Measurement source not connected');
    expect(wrapper.text()).toContain(
      'Incomplete measurement days remain unscored',
    );
    expect(wrapper.text()).toContain('12 future daily predictions');
    expect(wrapper.findAll('table')).toHaveLength(0);
  });
  it('shows station location, received metrics, measurement age and current collection failure', async () => {
    wrapper = mount(DailyVerification, {
      props: {
        collection: {
          status: 'available',
          source: 'station',
          note: 'Station is not at your house.',
          station: { id: '15502', name: 'Vidin', distanceKm: 19.47 },
          availableMetrics: ['temperature_c'],
          lastObservedAt: '2026-10-10T10:00:00Z',
        },
      },
    });
    expect(wrapper.text()).toContain('19.5 km from forecast location');
    expect(wrapper.text()).toContain('Measurements received: temperature');
    expect(wrapper.text()).toContain('Latest measurement');
    await wrapper.setProps({
      collection: {
        status: 'unavailable',
        source: 'station',
        note: 'Collection failed.',
      },
    });
    expect(wrapper.text()).toContain('Station collection unavailable');
    expect(wrapper.text()).not.toContain('Latest measurement');
  });
  it('shows the daily migration state separately', () => {
    wrapper = mount(DailyVerification, {
      props: {
        daily: { status: 'migration-required', summary: [], recent: [] },
      },
    });
    expect(wrapper.text()).toContain(
      'Daily forecast storage needs initialization',
    );
  });
  it.each([
    ['icon_seamless:weather-v1', 'DWD ICON'],
    ['open-meteo:ncep_gfs_seamless', 'NOAA GFS'],
    ['daily-cautious:weather-v1', 'Energrid daily selection'],
    ['selected-cautious:weather-v1', 'Energrid hourly selection'],
    ['unknown', 'unknown'],
  ])(
    'labels model identity independently of its version: %s',
    (value, expected) => {
      expect(weatherModelName(value)).toBe(expected);
    },
  );
});
