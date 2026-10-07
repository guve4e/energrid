import { buildDailyOutlook, isPopulatedDailyForecast } from './weather-daily-outlook';
import { WeatherDay, WeatherSnapshot } from './weather-data-quality';

const day = (date: string, overrides: Partial<WeatherDay> = {}): WeatherDay => ({
  date,
  tempMax: 20,
  tempMin: 10,
  rainTotalMm: 0,
  rainChanceMax: 0,
  weatherCode: 1,
  condition: 'Mainly clear',
  windMaxKmh: 10,
  gustMaxKmh: 15,
  ...overrides,
});

const emptyDay = (date: string): WeatherDay => day(date, {
  tempMax: null,
  tempMin: null,
  rainTotalMm: null,
  rainChanceMax: null,
  weatherCode: null,
  condition: 'Unknown',
  windMaxKmh: null,
  gustMaxKmh: null,
});

const snapshot = (model: string, daily: WeatherDay[], availability: WeatherSnapshot['availability'] = 'available'): WeatherSnapshot => ({
  location: 'Vidin',
  coordinates: { latitude: 43.9916, longitude: 22.8728 },
  provider: 'open-meteo',
  model,
  fetchedAt: '2026-10-06T10:00:00.000Z',
  availability,
  units: { temperature: 'celsius', wind: 'km/h', precipitation: 'mm' },
  current: {
    time: '2026-10-06T10:00:00.000Z',
    temperature: 20,
    feelsLike: 20,
    humidity: 50,
    pressure: 1010,
    windKmh: 10,
    gustKmh: 15,
    weatherCode: 1,
    condition: 'Mainly clear',
  },
  hourly: [],
  daily,
  alerts: [],
});

describe('daily weather outlook selection', () => {
  it('keeps selected-model days when models agree and fills later missing days from another available model', () => {
    const icon = snapshot('icon_seamless', [
      day('2026-10-06', { tempMax: 25.7 }),
      day('2026-10-07', { tempMax: 25.6 }),
      day('2026-10-08', { tempMax: 26.7 }),
      day('2026-10-09', { tempMax: 26.8 }),
      day('2026-10-10', { tempMax: 20.2 }),
      day('2026-10-11', { tempMax: 23.8 }),
      day('2026-10-12', { tempMax: 25.5 }),
      emptyDay('2026-10-13'),
      emptyDay('2026-10-14'),
      emptyDay('2026-10-15'),
      emptyDay('2026-10-16'),
      emptyDay('2026-10-17'),
    ]);
    const agreeingMaxTemps = [25.4, 25.4, 26.4, 26.5, 20, 23.5, 25.3];
    const gfs = snapshot('ncep_gfs_seamless', Array.from({ length: 12 }, (_, index) =>
      day(`2026-10-${String(index + 6).padStart(2, '0')}`, { tempMax: index < 7 ? agreeingMaxTemps[index] : 30 + index })));

    const outlook = buildDailyOutlook(icon, [icon, gfs]);

    expect(outlook.days).toHaveLength(10);
    expect(outlook.days.map((item) => item.date)).toEqual([
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
    ]);
    expect(outlook.days[0]).toMatchObject({
      sourceModel: 'icon_seamless',
      isFallback: false,
      agreement: 'agreement',
      tempMax: 25.7,
    });
    expect(outlook.days[7]).toMatchObject({
      sourceModel: 'ncep_gfs_seamless',
      isFallback: true,
      agreement: 'single-model',
      tempMax: 37,
    });
    expect(outlook.days.every((item) => item.tempMax !== null && item.tempMin !== null)).toBe(true);
    expect(outlook.agreementDays).toBe(7);
    expect(outlook.singleModelDays).toBe(3);
  });

  it('selects the more cautious daily forecast when models disagree', () => {
    const icon = snapshot('icon_seamless', [day('2026-10-06', {
      weatherCode: 1,
      condition: 'Mainly clear',
      rainTotalMm: 0,
      rainChanceMax: 5,
      gustMaxKmh: 16,
    })]);
    const gfs = snapshot('ncep_gfs_seamless', [day('2026-10-06', {
      weatherCode: 63,
      condition: 'Moderate rain',
      rainTotalMm: 8,
      rainChanceMax: 65,
      gustMaxKmh: 30,
    })]);

    const outlook = buildDailyOutlook(icon, [icon, gfs]);

    expect(outlook.days).toHaveLength(1);
    expect(outlook.days[0]).toMatchObject({
      sourceModel: 'ncep_gfs_seamless',
      condition: 'Moderate rain',
      agreement: 'disagreement',
      isFallback: true,
      selectionReason: 'Models disagree for this date; showing the more cautious daily forecast.',
    });
    expect(outlook.days[0].disagreementReasons).toEqual([
      'daily-risk-category-differs',
      'rain-total-spread-at-least-2-mm',
      'rain-probability-spread-at-least-30-points',
    ]);
    expect(outlook.disagreementDays).toBe(1);
  });

  it('does not overwrite a selected-model day when both models are close enough', () => {
    const icon = snapshot('icon_seamless', [day('2026-10-06', { tempMax: 21 })]);
    const gfs = snapshot('ncep_gfs_seamless', [day('2026-10-06', { tempMax: 22, gustMaxKmh: 17 })]);

    const outlook = buildDailyOutlook(icon, [gfs, icon]);

    expect(outlook.days).toHaveLength(1);
    expect(outlook.days[0]).toMatchObject({
      tempMax: 21,
      sourceModel: 'icon_seamless',
      agreement: 'agreement',
      isFallback: false,
    });
  });

  it('does not use unavailable models to extend the daily horizon', () => {
    const icon = snapshot('icon_seamless', [day('2026-10-06'), emptyDay('2026-10-07')]);
    const gfs = snapshot('ncep_gfs_seamless', [day('2026-10-07')], 'unavailable');

    const outlook = buildDailyOutlook(icon, [icon, gfs]);

    expect(outlook.days.map((item) => item.date)).toEqual(['2026-10-06']);
  });

  it('treats all-null unknown daily rows as empty provider padding', () => {
    expect(isPopulatedDailyForecast(emptyDay('2026-10-13'))).toBe(false);
    expect(isPopulatedDailyForecast(day('2026-10-13', { rainTotalMm: 0 }))).toBe(true);
  });
});
