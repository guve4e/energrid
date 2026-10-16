import {
  dailyPredictions,
  measuredDailyValue,
  DAILY_POLICY_VERSION,
} from './weather-daily-verification';
import { weatherDate, weatherDayWindow } from './weather-calendar';
import { HOUR_MS, WeatherSnapshot } from './weather-data-quality';
import { WeatherDailyVerificationService } from './weather-daily-verification.service';
import { WeatherVerificationController } from './weather-verification.controller';
import { WeatherVerificationScheduler } from './weather-verification.scheduler';
import { WeatherRiskEngine } from './weather-risk.engine';
import { WeatherIntelligenceService } from './weather-intelligence.service';

const now = new Date('2026-10-14T10:20:00Z');
function snapshot(model = 'icon_seamless'): WeatherSnapshot {
  const reading = {
    time: now.toISOString(),
    temperature: 20,
    feelsLike: 20,
    humidity: 50,
    pressure: 1000,
    windKmh: 10,
    gustKmh: 20,
    weatherCode: 0,
    condition: 'Clear',
  };
  return {
    location: 'Vidin',
    coordinates: { latitude: 43.9916, longitude: 22.8728 },
    provider: 'open-meteo',
    model,
    fetchedAt: now.toISOString(),
    availability: 'available',
    units: { temperature: 'celsius', wind: 'km/h', precipitation: 'mm' },
    current: reading,
    alerts: [],
    hourly: Array.from({ length: 30 }, (_, i) => ({
      ...reading,
      time: new Date(
        Date.parse('2026-10-14T10:00:00Z') + i * HOUR_MS,
      ).toISOString(),
      rainChance: 20,
      precipitationMm: 0,
      rainMm: 0,
      showersMm: 0,
    })),
    daily: Array.from({ length: 12 }, (_, i) => ({
      date: new Date(Date.parse('2026-10-14') + i * 24 * HOUR_MS)
        .toISOString()
        .slice(0, 10),
      tempMax: 20,
      tempMin: 10,
      rainTotalMm: 5,
      rainChanceMax: 30,
      weatherCode: 61,
      condition: 'Rain',
      windMaxKmh: 15,
      gustMaxKmh: 25,
    })),
  };
}
function measurements(date = '2026-10-15', value = 1) {
  const window = weatherDayWindow(date);
  return Array.from({ length: window.expectedHours }, (_, i) => ({
    id: String(i + 1),
    windowStartAt: new Date(
      window.startsAt.getTime() + i * HOUR_MS,
    ).toISOString(),
    observedAt: new Date(
      window.startsAt.getTime() + (i + 1) * HOUR_MS,
    ).toISOString(),
    value,
  }));
}

describe('daily forecast evidence', () => {
  it.each([
    ['2026-03-29', 23],
    ['2026-10-25', 25],
    ['2026-10-15', 24],
  ])('uses complete local day boundaries for %s', (date, hours) => {
    const window = weatherDayWindow(date as string);
    expect(window.expectedHours).toBe(hours);
    expect(weatherDate(window.startsAt)).toBe(date);
    expect(weatherDate(window.endsAt.getTime() - 1)).toBe(date);
    expect(weatherDate(window.endsAt)).not.toBe(date);
  });
  it.each(['2026-02-30', 'not-a-date', '2026-13-01'])(
    'rejects invalid calendar date %s',
    (date) => {
      expect(() => weatherDayWindow(date)).toThrow('Invalid');
    },
  );
  it('preserves all models and the actual daily policy for ten future days, never the elapsed part of today', () => {
    const a = snapshot();
    const b = snapshot('ncep_gfs_seamless');
    b.daily[3].rainTotalMm = 30;
    const predictions = dailyPredictions([a, b], a, now);
    expect(predictions).toHaveLength(120);
    expect(new Set(predictions.map((p) => p.leadDays))).toEqual(
      new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    );
    expect(
      predictions.every(
        (p) => p.startsAt > now && p.targetDate !== '2026-10-14',
      ),
    ).toBe(true);
    const choice = predictions.find(
      (p) =>
        p.modelVersion === DAILY_POLICY_VERSION &&
        p.targetDate === b.daily[3].date &&
        p.metric === 'precipitation_mm',
    );
    expect(choice).toMatchObject({
      predicted: 30,
      provider: 'energrid',
      input: { sourceModel: 'ncep_gfs_seamless', agreement: 'disagreement' },
    });
    expect(choice!.input.selectionReason).toContain('more cautious');
  });
  it('does not invent unavailable forecasts, score invalid values, or duplicate a source', () => {
    const a = snapshot();
    a.daily[1].rainTotalMm = null;
    a.daily[2].gustMaxKmh = NaN;
    a.daily[3].rainTotalMm = -1;
    a.daily[4].date = '2026-02-30';
    const unavailable = {
      ...snapshot('gfs'),
      availability: 'unavailable' as const,
    };
    const stale = { ...snapshot('old'), fetchedAt: '2026-10-13T00:00:00Z' };
    const result = dailyPredictions([a, a, unavailable, stale], a, now);
    expect(result.filter((p) => p.provider === 'open-meteo')).toHaveLength(33);
    expect(
      result.every((p) => Number.isFinite(p.predicted) && p.predicted >= 0),
    ).toBe(true);
    expect(
      result.some(
        (p) => p.modelVersion.includes('gfs') || p.modelVersion.includes('old'),
      ),
    ).toBe(false);
  });
  it('keeps zero as evidence and records a single-model day as such', () => {
    const a = snapshot();
    a.daily[1].rainTotalMm = 0;
    expect(
      dailyPredictions([a], a, now).find(
        (p) =>
          p.modelVersion === DAILY_POLICY_VERSION &&
          p.targetDate === a.daily[1].date &&
          p.metric === 'precipitation_mm',
      ),
    ).toMatchObject({ predicted: 0, input: { agreement: 'single-model' } });
  });
  it('does not replace an unusable daily choice with a different model and pretend that was the displayed policy', () => {
    const a = snapshot();
    const b = snapshot('ncep_gfs_seamless');
    b.fetchedAt = '2026-10-13T00:00:00Z';
    b.daily[1].rainTotalMm = 50;
    const rows = dailyPredictions([a, b], a, now);
    expect(
      rows.some(
        (p) =>
          p.modelVersion === DAILY_POLICY_VERSION &&
          p.targetDate === b.daily[1].date,
      ),
    ).toBe(false);
    expect(
      rows.some(
        (p) => p.provider === 'open-meteo' && p.targetDate === a.daily[1].date,
      ),
    ).toBe(true);
  });
  it.each(['2026-03-29', '2026-10-25', '2026-10-15'])(
    'scores exact coverage for %s',
    (date) => {
      const window = weatherDayWindow(date);
      const rows = measurements(date);
      expect(
        measuredDailyValue(
          'precipitation_mm',
          window.startsAt,
          window.endsAt,
          rows,
        )?.value,
      ).toBe(window.expectedHours);
      expect(
        measuredDailyValue('gust_kmh', window.startsAt, window.endsAt, rows)
          ?.value,
      ).toBe(1);
    },
  );
  it('distinguishes daily totals from peak gusts and accepts true measured zero', () => {
    const { startsAt, endsAt } = weatherDayWindow('2026-10-15');
    const rows = measurements();
    rows[2].value = 10;
    expect(
      measuredDailyValue('precipitation_mm', startsAt, endsAt, rows)?.value,
    ).toBe(33);
    expect(measuredDailyValue('gust_kmh', startsAt, endsAt, rows)?.value).toBe(
      10,
    );
    expect(
      measuredDailyValue(
        'precipitation_mm',
        startsAt,
        endsAt,
        measurements('2026-10-15', 0),
      )?.value,
    ).toBe(0);
  });
  it('rejects partial, duplicate, misaligned, negative and invalid measurement days', () => {
    const { startsAt, endsAt } = weatherDayWindow('2026-10-15');
    const valid = measurements();
    const duplicate = [...valid];
    duplicate[1] = duplicate[0];
    const misaligned = valid.map((o) => ({ ...o }));
    misaligned[0].observedAt = '2026-10-14T22:30:00Z';
    for (const rows of [
      [],
      valid.slice(1),
      [...valid, valid[0]],
      duplicate,
      misaligned,
      valid.map((o) => ({ ...o, value: -1 })),
      valid.map((o) => ({ ...o, value: NaN })),
    ]) {
      expect(
        measuredDailyValue('precipitation_mm', startsAt, endsAt, rows),
      ).toBeNull();
    }
  });
});

describe('daily verification persistence and wiring', () => {
  it('records immutable snapshots with original issue time, daily source and timezone', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 1 });
    const service = new WeatherDailyVerificationService({ query } as never);
    const a = snapshot();
    expect(await service.record([a], a, now)).toEqual({ recorded: 80 });
    expect(query.mock.calls.every(([sql]) => sql.includes('DO NOTHING'))).toBe(
      true,
    );
    expect(query.mock.calls[0][1][3]).toEqual(now);
    expect(query.mock.calls[0][1][6]).toBe('Europe/Sofia');
  });
  it('matches only complete closed windows and stores the exact observation IDs and signed error', async () => {
    const window = weatherDayWindow('2026-10-15');
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            metric: 'precipitation_mm',
            predicted: 5,
            starts_at: window.startsAt,
            ends_at: window.endsAt,
            measurements: measurements('2026-10-15', 0.1),
          },
          {
            id: 2,
            metric: 'precipitation_mm',
            predicted: 5,
            starts_at: window.startsAt,
            ends_at: window.endsAt,
            measurements: measurements().slice(1),
          },
        ],
      })
      .mockResolvedValue({ rowCount: 1 });
    const service = new WeatherDailyVerificationService({ query } as never);
    expect(await service.evaluate('station')).toEqual({ evaluated: 1 });
    const [sql, args] = query.mock.calls[0];
    expect(sql).toContain('f.ends_at<=now()');
    expect(sql).toContain('f.created_at<f.starts_at');
    expect(sql).toContain('HAVING count(*)');
    expect(sql).toContain('mod(extract');
    expect(args).toEqual(['station']);
    const values = query.mock.calls[1][1];
    expect(values[1]).toBeCloseTo(2.4);
    expect(values[2]).toBe('station');
    expect(values[3]).toHaveLength(24);
    expect(values[6]).toBeCloseTo(-2.6);
    expect(query.mock.calls[1][0]).toContain('evaluated_at IS NULL');
  });
  it('does not evaluate without a measured source', async () => {
    const query = jest.fn();
    expect(
      await new WeatherDailyVerificationService({ query } as never).evaluate(
        '',
      ),
    ).toEqual({ evaluated: 0 });
    expect(query).not.toHaveBeenCalled();
  });
  it('separates metric, source and lead days and reports verified days, not just correlated snapshots', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ verifiedDays: 3 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ scheduled: 4, awaitingObservations: 2 }],
      });
    const result = await new WeatherDailyVerificationService({
      query,
    } as never).performance();
    expect(result.status).toBe('available');
    expect(result.summary[0].verifiedDays).toBe(3);
    expect(query.mock.calls[0][0]).toContain(
      'GROUP BY provider,model_version,metric,lead_days,observation_source',
    );
    expect(query.mock.calls[0][0]).toContain('count(DISTINCT target_date)');
    expect(query.mock.calls[1][0]).toContain('DISTINCT ON');
  });
  it('does not hide hourly results while the daily migration is missing', async () => {
    const controller = new WeatherVerificationController(
      { performance: jest.fn().mockResolvedValue({ summary: [] }) } as never,
      { performance: jest.fn().mockRejectedValue({ code: '42P01' }) } as never,
      { status: () => ({ status: 'configuration-required' }) } as never,
    );
    expect(await controller.performance()).toMatchObject({
      summary: [],
      daily: { status: 'migration-required' },
      collection: { status: 'configuration-required' },
    });
  });
  it('reports unexpected daily storage failures as an outage', async () => {
    const controller = new WeatherVerificationController(
      { performance: jest.fn().mockResolvedValue({ summary: [] }) } as never,
      {
        performance: jest.fn().mockRejectedValue(new Error('offline')),
      } as never,
      {} as never,
    );
    await expect(controller.performance()).rejects.toThrow(
      'temporarily unavailable',
    );
  });
  it('records both forecast paths and still evaluates daily forecasts when hourly scoring fails', async () => {
    const hourly = {
      record: jest.fn(),
      evaluate: jest.fn().mockRejectedValue(new Error('offline')),
    };
    const daily = { record: jest.fn(), evaluate: jest.fn() };
    const collector = { collect: jest.fn() };
    const scheduler = new WeatherVerificationScheduler(
      { getSnapshot: jest.fn().mockResolvedValue(snapshot()) } as never,
      new WeatherRiskEngine(),
      new WeatherIntelligenceService(),
      hourly as never,
      daily as never,
      collector as never,
    );
    await scheduler.runCycle();
    expect(hourly.record).toHaveBeenCalledTimes(1);
    expect(daily.record).toHaveBeenCalledTimes(1);
    expect(collector.collect).toHaveBeenCalledTimes(1);
    expect(daily.evaluate).toHaveBeenCalledTimes(1);
  });
  it('keeps daily recording independent of an hourly recording failure', async () => {
    const daily = { record: jest.fn(), evaluate: jest.fn() };
    const scheduler = new WeatherVerificationScheduler(
      { getSnapshot: jest.fn().mockResolvedValue(snapshot()) } as never,
      new WeatherRiskEngine(),
      new WeatherIntelligenceService(),
      {
        record: jest
          .fn()
          .mockRejectedValue(new Error('hourly storage unavailable')),
        evaluate: jest.fn(),
      } as never,
      daily as never,
      { collect: jest.fn() } as never,
    );
    await scheduler.runCycle();
    expect(daily.record).toHaveBeenCalledTimes(1);
    expect(daily.evaluate).toHaveBeenCalledTimes(1);
  });
});
