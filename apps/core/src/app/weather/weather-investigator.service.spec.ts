import { WeatherSnapshot } from './weather-data-quality';
import {
  FixtureWeatherInvestigatorProvider,
  WeatherInvestigatorProvider,
} from './weather-investigator';
import { WeatherInvestigatorService } from './weather-investigator.service';

function snapshot(
  location: string,
  latitude: number,
  longitude: number,
  fetchedAt = new Date().toISOString(),
): WeatherSnapshot {
  const start = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  return {
    location,
    coordinates: { latitude, longitude },
    provider: 'open-meteo',
    model: 'icon_seamless',
    availability: 'available',
    fetchedAt,
    units: { temperature: 'celsius', wind: 'km/h', precipitation: 'mm' },
    current: {
      time: new Date(start).toISOString(),
      temperature: 8,
      feelsLike: 8,
      humidity: 50,
      pressure: 1000,
      windKmh: 10,
      gustKmh: 15,
      weatherCode: 1,
      condition: 'Clear',
    },
    hourly: Array.from({ length: 80 }, (_, i) => ({
      time: new Date(start + i * 3_600_000).toISOString(),
      temperature: 8,
      feelsLike: 8,
      humidity: 50,
      pressure: 1000,
      rainChance: i === 48 ? 80 : 10,
      precipitationMm: i === 48 ? 4 : 0,
      rainMm: 0,
      showersMm: 0,
      weatherCode: i === 48 ? 63 : 1,
      condition: 'Clear',
      windKmh: 10,
      gustKmh: 15,
    })),
    daily: [],
    alerts: [],
  };
}

function setup(provider?: WeatherInvestigatorProvider) {
  const inserted = new Set<string>();
  const client = {
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes('pg_try_advisory_lock'))
        return { rows: [{ locked: true }], rowCount: 1 };
      if (sql.includes('SELECT evidence FROM weather_investigation_snapshots'))
        return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO weather_investigation_snapshots'))
        return { rows: [{ id: '5' }], rowCount: 1 };
      if (sql.includes('INSERT INTO weather_investigation_findings')) {
        const key = `${values[0]}:${values[1]}:${values[3]}`;
        if (inserted.has(key)) return { rows: [], rowCount: 0 };
        inserted.add(key);
        return { rows: [{ id: '12' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };
  const pool = {
    connect: jest.fn().mockResolvedValue(client),
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  };
  const weather = {
    getDefaultLocation: () => ({
      location: 'Vidin',
      latitude: 43.9916,
      longitude: 22.8728,
    }),
    getSnapshotForLocation: jest.fn(
      async (loc: { location: string; latitude: number; longitude: number }) =>
        snapshot(loc.location, loc.latitude, loc.longitude),
    ),
  };
  const active = provider ?? new FixtureWeatherInvestigatorProvider();
  return {
    service: new WeatherInvestigatorService(
      pool as never,
      weather as never,
      active,
    ),
    client,
    pool,
    weather,
    inserted,
  };
}

describe('weather investigator persistence and recovery policy', () => {
  const original = process.env;
  afterEach(() => {
    process.env = original;
  });

  it('deduplicates repeated evaluations across service restarts', async () => {
    process.env = { ...original, ENERGRID_LAB_MODE: 'true' };
    const first = setup();
    const second = setup();
    // A shared database uniqueness index is modeled by the stable key supplied to INSERT.
    const keys = new Set<string>();
    const dbInsert = async (sql: string, values: unknown[] = []) => {
      if (sql.includes('INSERT INTO weather_investigation_findings')) {
        const key = `${values[0]}:${values[1]}:${values[3]}`;
        if (keys.has(key)) return { rows: [], rowCount: 0 };
        keys.add(key);
        return { rows: [{ id: '12' }], rowCount: 1 };
      }
      return undefined;
    };
    first.client.query.mockImplementation(
      async (sql, values = []) =>
        (await dbInsert(sql, values)) ??
        (sql.includes('pg_try_advisory_lock')
          ? { rows: [{ locked: true }], rowCount: 1 }
          : sql.includes('INSERT INTO weather_investigation_snapshots')
            ? { rows: [{ id: '5' }], rowCount: 1 }
            : { rows: [], rowCount: 0 }),
    );
    second.client.query.mockImplementation(
      first.client.query.getMockImplementation()!,
    );
    // Use a stable forecast timestamp so both restarts see the same event date and ID.
    const stable = snapshot('Vidin', 43.9916, 22.8728);
    first.weather.getSnapshotForLocation.mockResolvedValue(stable);
    second.weather.getSnapshotForLocation.mockResolvedValue(stable);
    const one = await first.service.run('site-a', 'tenant-a');
    const two = await second.service.run('site-a', 'tenant-a');
    expect(one.createdOrUpdated).toBe(1);
    expect(two.createdOrUpdated).toBe(0);
    expect(first.client.release).toHaveBeenCalled();
    expect(second.client.release).toHaveBeenCalled();
  });

  it('falls back safely when a configured investigator returns malformed findings', async () => {
    process.env = { ...original };
    const broken = {
      id: 'test-llm',
      investigate: async () => ({
        findings: [{ eventType: 'official_warning' }],
        summary: 'bad',
        model: 'test',
      }),
    } as unknown as WeatherInvestigatorProvider;
    const { service, client } = setup(broken);
    const result = await service.run('site-a', 'tenant-a');
    expect(result.provider).toBe('fixture');
    expect(result.summary).toContain('резервна оценка');
    expect(
      client.query.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO weather_investigation_findings'),
      ),
    ).toBe(true);
  });

  it('uses the deterministic fallback when the configured investigator is unavailable', async () => {
    process.env = { ...original };
    const unavailable = {
      id: 'test-llm',
      investigate: async () => { throw new Error('provider unavailable'); },
    } as unknown as WeatherInvestigatorProvider;
    const { service } = setup(unavailable);
    const result = await service.run('site-a', 'tenant-a');
    expect(result.provider).toBe('fixture');
    expect(result.summary).toContain('недостъпен');
    expect(result.createdOrUpdated).toBe(1);
  });

  it('keeps weather evidence and findings scoped to configured site locations', async () => {
    process.env = {
      ...original,
      WEATHER_SITE_LOCATIONS_JSON: JSON.stringify({
        'site-a': {
          tenantId: 'tenant-a',
          siteId: 'site-a',
          location: 'Vidin',
          latitude: 43.9916,
          longitude: 22.8728,
        },
        'site-b': {
          tenantId: 'tenant-b',
          siteId: 'site-b',
          location: 'Sofia',
          latitude: 42.6977,
          longitude: 23.3219,
        },
      }),
    };
    const { service, weather } = setup();
    await service.run('site-a', 'tenant-a');
    await service.run('site-b', 'tenant-b');
    expect(weather.getSnapshotForLocation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ location: 'Vidin', latitude: 43.9916 }),
      'icon_seamless',
    );
    expect(weather.getSnapshotForLocation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ location: 'Sofia', latitude: 42.6977 }),
      'icon_seamless',
    );
  });

  it('does not persist stale forecasts', async () => {
    process.env = { ...original };
    const { service, client, weather } = setup();
    weather.getSnapshotForLocation.mockResolvedValue(
      snapshot('Vidin', 43.9916, 22.8728, '2026-01-01T00:00:00.000Z'),
    );
    const result = await service.run('site-a', 'tenant-a');
    expect(result.status).toBe('stale-or-incomplete');
    expect(
      client.query.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO weather_investigation_snapshots'),
      ),
    ).toBe(false);
  });
});
