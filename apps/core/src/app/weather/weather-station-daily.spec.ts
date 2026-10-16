import {
  dailyPeriodConfiguration,
  meteostatDailyObservations,
} from './weather-station-daily';
import {
  DAILY_REVISION_MESSAGE,
  WeatherStationDailyService,
} from './weather-station-daily.service';
import { WeatherObservationCollector } from './weather-observation-collector.service';
import { WeatherDailyVerificationService } from './weather-daily-verification.service';
import { weatherObservationSource } from './weather-observations';

const now = new Date('2026-10-15T19:30:00Z');
const env = process.env;
const period = {
  verified: true,
  reference: 'Station operator confirms midnight-to-midnight Europe/Sofia',
  timezone: 'Europe/Sofia',
};
const station = {
  id: '15502',
  name: { en: 'Vidin' },
  timezone: 'Europe/Sofia',
  location: { latitude: 43.8167, longitude: 22.8833 },
};
const week = [0, 0, 0, 8.3, 2.9, 6.5, 6.7].map((prcp, i) => ({
  date: `2026-10-${String(i + 8).padStart(2, '0')} 00:00:00`,
  prcp,
  tmin: 3,
  tmax: 20,
  wpgt: null,
  wspd: 10,
}));
function configure() {
  process.env = {
    ...env,
    WEATHER_OBSERVATION_PROVIDER: 'meteostat',
    WEATHER_OBSERVATION_COLLECTION_ENABLED: 'true',
    METEOSTAT_GRANULARITY: 'daily',
    METEOSTAT_STATION_ID: '15502',
    METEOSTAT_API_KEY: 'private-test-key',
  };
  delete process.env.METEOSTAT_DAILY_PERIOD_VERIFIED;
  delete process.env.METEOSTAT_DAILY_PERIOD_REFERENCE;
  delete process.env.METEOSTAT_DAILY_TIMEZONE;
}
function store() {
  return {
    claimCollection: jest.fn().mockResolvedValue({ claimed: true }),
    saveCollectionStatus: jest.fn(),
    ingest: jest.fn(),
  };
}
function feed(data: unknown = week) {
  return jest
    .spyOn(global, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: station }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data }),
    } as Response);
}
afterEach(() => {
  process.env = env;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('native daily observations', () => {
  it('normalizes the supplied seven-day report without inventing hourly measurements or gusts', () => {
    const observations = meteostatDailyObservations(week, now, {
      verified: false,
      reference: null,
      timezone: 'Europe/Sofia',
    });
    expect(observations).toHaveLength(21);
    expect(
      observations
        .filter((o) => o.metric === 'precipitation_mm')
        .reduce((sum, o) => sum + o.value, 0),
    ).toBeCloseTo(24.4);
    expect(observations.filter((o) => o.metric === 'gust_kmh')).toHaveLength(0);
    expect(
      observations.every(
        (o) =>
          o.startsAt === null &&
          o.endsAt === null &&
          o.periodBasis === 'unverified',
      ),
    ).toBe(true);
    expect(
      observations.some(
        (o) => o.metric === 'precipitation_mm' && o.value === 0,
      ),
    ).toBe(true);
  });
  it('requires explicit period verification, timezone and a reference, not merely a midnight date string', () => {
    expect(
      dailyPeriodConfiguration({ METEOSTAT_DAILY_PERIOD_VERIFIED: 'true' })
        .verified,
    ).toBe(false);
    expect(
      dailyPeriodConfiguration({
        METEOSTAT_DAILY_PERIOD_VERIFIED: 'true',
        METEOSTAT_DAILY_TIMEZONE: 'UTC',
        METEOSTAT_DAILY_PERIOD_REFERENCE: 'operator',
      }).verified,
    ).toBe(false);
    expect(
      dailyPeriodConfiguration({
        METEOSTAT_DAILY_PERIOD_VERIFIED: 'true',
        METEOSTAT_DAILY_TIMEZONE: 'Europe/Sofia',
        METEOSTAT_DAILY_PERIOD_REFERENCE: 'operator',
      }).verified,
    ).toBe(true);
    expect(
      meteostatDailyObservations(week, now, period, 'Europe/Bucharest')[0]
        .periodBasis,
    ).toBe('unverified');
  });
  it.each([
    ['2026-03-29', 23],
    ['2026-10-25', 25],
  ])(
    'uses exact daylight-saving periods for verified daily report %s',
    (date, hours) => {
      const later = new Date('2026-10-30T12:00:00Z');
      const clock =
        date === '2026-03-29' ? new Date('2026-04-01T12:00:00Z') : later;
      const observation = meteostatDailyObservations(
        [{ date, prcp: 1 }],
        clock,
        period,
      )[0];
      expect(
        (Date.parse(observation.endsAt!) - Date.parse(observation.startsAt!)) /
          3600000,
      ).toBe(hours);
    },
  );
  it('rejects invalid, future, too-old, missing, negative precipitation and non-numeric values', () => {
    expect(
      meteostatDailyObservations(
        [
          { date: '2026-02-30', prcp: 1 },
          { date: '2026-10-15', prcp: 1 },
          { date: '2026-09-01', prcp: 1 },
          { date: '2026-10-14 12:00:00', prcp: 1 },
          { date: '2026-10-14', prcp: null, wpgt: -1, tmin: '3', tmax: NaN },
        ],
        now,
        period,
      ),
    ).toEqual([]);
    expect(() =>
      meteostatDailyObservations(
        [{ date: '2026-10-14', tmin: 20, tmax: 10 }],
        now,
        period,
      ),
    ).toThrow('temperature range');
  });
  it('keeps negative temperature valid and rejects conflicting duplicate reports', () => {
    expect(
      meteostatDailyObservations(
        [{ date: '2026-10-14', tmin: -5, tmax: 2 }],
        now,
        period,
      ).map((o) => o.value),
    ).toEqual([-5, 2]);
    expect(
      meteostatDailyObservations([week[0], week[0]], now, period),
    ).toHaveLength(3);
    expect(() =>
      meteostatDailyObservations(
        [week[0], { ...week[0], prcp: 5 }],
        now,
        period,
      ),
    ).toThrow('Conflicting');
  });
  it('separates native daily, unverified daily and hourly source identities', () => {
    configure();
    expect(weatherObservationSource()).toBe('meteostat:15502:daily-unverified');
    process.env.METEOSTAT_DAILY_PERIOD_VERIFIED = 'true';
    process.env.METEOSTAT_DAILY_TIMEZONE = 'Europe/Sofia';
    process.env.METEOSTAT_DAILY_PERIOD_REFERENCE = 'operator';
    expect(weatherObservationSource()).toBe(
      'meteostat:15502:daily-local-Europe-Sofia-v1',
    );
  });
});

describe('daily collection and quota protection', () => {
  it('stays disabled unless explicitly enabled, even with a server key', async () => {
    configure();
    delete process.env.WEATHER_OBSERVATION_COLLECTION_ENABLED;
    const fetch = jest.spyOn(global, 'fetch');
    const repository = store();
    expect(
      await new WeatherObservationCollector(
        {} as never,
        repository as never,
      ).collect(now),
    ).toMatchObject({ status: 'disabled' });
    expect(fetch).not.toHaveBeenCalled();
    expect(repository.claimCollection).not.toHaveBeenCalled();
  });
  it('fetches native daily data with model=false, stores unverified reports, and never calls hourly ingest', async () => {
    configure();
    const repository = store();
    const hourly = { ingest: jest.fn() };
    const fetch = feed();
    const result = await new WeatherObservationCollector(
      hourly as never,
      repository as never,
    ).collect(now);
    expect(result).toMatchObject({
      status: 'reporting-period-unverified',
      granularity: 'daily',
      records: 21,
    });
    const url = new URL(String(fetch.mock.calls[1][0]));
    expect(url.pathname).toBe('/stations/daily');
    expect(url.searchParams.get('model')).toBe('false');
    expect(url.searchParams.get('end')).toBe('2026-10-14');
    expect(url.searchParams.has('tz')).toBe(false);
    expect(repository.ingest).toHaveBeenCalledWith(
      'meteostat:15502:daily-unverified',
      '43.99160,22.87280',
      expect.any(Array),
      expect.objectContaining({ id: '15502' }),
    );
    expect(hourly.ingest).not.toHaveBeenCalled();
    expect(result.availableMetrics).not.toContain('gust_kmh');
    expect(JSON.stringify(result)).not.toContain('private-test-key');
  });
  it('restores the persisted attempt status after restart and makes no HTTP calls within the quota interval', async () => {
    configure();
    const repository = store();
    repository.claimCollection.mockResolvedValue({
      claimed: false,
      snapshot: {
        status: 'reporting-period-unverified',
        source: weatherObservationSource(),
        records: 21,
      },
    });
    const fetch = jest.spyOn(global, 'fetch');
    expect(
      await new WeatherObservationCollector(
        {} as never,
        repository as never,
      ).collect(now),
    ).toMatchObject({ records: 21 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('stores a verified period only after station timezone and configured period evidence agree', async () => {
    configure();
    process.env.METEOSTAT_DAILY_PERIOD_VERIFIED = 'true';
    process.env.METEOSTAT_DAILY_TIMEZONE = 'Europe/Sofia';
    process.env.METEOSTAT_DAILY_PERIOD_REFERENCE = 'operator';
    const repository = store();
    feed();
    expect(
      await new WeatherObservationCollector(
        {} as never,
        repository as never,
      ).collect(now),
    ).toMatchObject({ status: 'available' });
    expect(
      repository.ingest.mock.calls[0][2].every(
        (o) => o.periodBasis === 'local-calendar-day',
      ),
    ).toBe(true);
  });
  it('keeps failed attempts under the same daily quota and persists a sanitized error', async () => {
    configure();
    const repository = store();
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('private-test-key'));
    const result = await new WeatherObservationCollector(
      {} as never,
      repository as never,
    ).collect(now);
    expect(result).toMatchObject({
      status: 'unavailable',
      nextCollectionAt: '2026-10-16T19:30:00.000Z',
    });
    expect(repository.saveCollectionStatus).toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private-test-key');
  });
});

describe('daily report storage and scoring', () => {
  it('claims collection atomically and uses persisted status when a different process already attempted it', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ status_snapshot: { status: 'available' } }],
      });
    expect(
      await new WeatherStationDailyService({ query } as never).claimCollection(
        'station',
        now,
      ),
    ).toEqual({ claimed: false, snapshot: { status: 'available' } });
    expect(query.mock.calls[0][0]).toContain("interval '24 hours'");
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT');
  });
  it('validates the entire batch before starting a transaction', async () => {
    const connect = jest.fn();
    const service = new WeatherStationDailyService({ connect } as never);
    const observation = meteostatDailyObservations(week, now, period)[0];
    await expect(
      service.ingest(
        'station',
        'site',
        [{ ...observation, value: NaN }],
        station,
      ),
    ).rejects.toThrow('Invalid');
    await expect(
      service.ingest(
        'station',
        'site',
        [{ ...observation, periodBasis: 'unverified' }],
        station,
      ),
    ).rejects.toThrow('invented');
    expect(connect).not.toHaveBeenCalled();
  });
  it('persists measured zero with the original source report and no model fill', async () => {
    jest.useFakeTimers().setSystemTime(now);
    const client = {
      query: jest.fn().mockResolvedValue({ rowCount: 1 }),
      release: jest.fn(),
    };
    const service = new WeatherStationDailyService({
      connect: jest.fn().mockResolvedValue(client),
    } as never);
    const observations = meteostatDailyObservations([week[0]], now, period);
    expect(
      await service.ingest('station', 'site', observations, station),
    ).toEqual({ recorded: 3 });
    const insert = client.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT'),
    )!;
    expect(insert[1][4]).toBe(0);
    expect(JSON.parse(insert[1][10])).toMatchObject({
      modelFill: false,
      station: { id: '15502' },
    });
    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });
  it('does not overwrite revised measurements and rolls the batch back', async () => {
    jest.useFakeTimers().setSystemTime(now);
    const client = {
      query: jest
        .fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ value: 9 }] })
        .mockResolvedValue({}),
      release: jest.fn(),
    };
    const service = new WeatherStationDailyService({
      connect: jest.fn().mockResolvedValue(client),
    } as never);
    await expect(
      service.ingest(
        'station',
        'site',
        meteostatDailyObservations([week[0]], now, period),
        station,
      ),
    ).rejects.toThrow(DAILY_REVISION_MESSAGE);
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
  it('scores only verified matching periods and retains the native observation identity', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [{ id: 2, predicted: 5, observation_id: 7, observed_value: 8.3 }],
      })
      .mockResolvedValue({ rowCount: 1 });
    expect(
      await new WeatherDailyVerificationService({ query } as never).evaluate(
        'station',
        'daily',
      ),
    ).toEqual({ evaluated: 1 });
    expect(query.mock.calls[0][0]).toContain(
      "o.period_basis='local-calendar-day'",
    );
    expect(query.mock.calls[0][0]).toContain('o.starts_at=f.starts_at');
    expect(query.mock.calls[0][0]).toContain('f.created_at<f.starts_at');
    expect(query.mock.calls[1][1]).toEqual([
      2,
      8.3,
      'station',
      7,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(query.mock.calls[1][0]).toContain(
      'station-daily-local-calendar-day',
    );
  });
  it('keeps missing or unverified native reports unscored', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    expect(
      await new WeatherDailyVerificationService({ query } as never).evaluate(
        'station',
        'daily',
      ),
    ).toEqual({ evaluated: 0 });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
