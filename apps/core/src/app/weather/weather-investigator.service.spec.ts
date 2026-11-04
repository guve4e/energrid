import { WeatherSnapshot } from './weather-data-quality';
import {
  FixtureWeatherInvestigatorProvider,
  WeatherEvidenceSnapshot,
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

/** A fixed future UTC date within the investigator's 72h forecast horizon. */
function futureSameDayIndex(): number {
  return 48 - new Date().getUTCHours();
}

function rainEpisodeProvider(
  ranges: Array<[number, number]>,
): WeatherInvestigatorProvider {
  return {
    id: 'controlled-rain',
    async investigate(evidence: WeatherEvidenceSnapshot) {
      return {
        findings: ranges.map(([first, last]) => ({
          eventType: 'rain' as const,
          startsAt: evidence.hours[first].time,
          endsAt: new Date(
            Date.parse(evidence.hours[last].time) + 3_600_000,
          ).toISOString(),
          location: evidence.location,
          severity: 'low' as const,
          confidence: 'low' as const,
          uncertainty: 'Възможен дъжд.',
          evidenceRefs: evidence.hours.slice(first, last + 1).map((hour) => hour.id),
          consequences: [],
          preparation: [],
          bulgarianExplanation: 'Прогноза за дъжд.',
        })),
        summary: 'Контролирана прогноза.',
        model: 'test-model',
      };
    },
  };
}

function rainSnapshot(indices: number[]): WeatherSnapshot {
  const result = snapshot('Vidin', 43.9916, 22.8728);
  for (const index of indices) {
    result.hourly[index].precipitationMm = 3;
    result.hourly[index].rainChance = 80;
  }
  return result;
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

  it('persists two separate rain episodes on the same UTC day with different keys', async () => {
    process.env = { ...original };
    const start = futureSameDayIndex();
    const { service, client, weather } = setup(rainEpisodeProvider([
      [start, start], [start + 2, start + 2],
    ]));
    weather.getSnapshotForLocation.mockResolvedValue(
      rainSnapshot([start, start + 2]),
    );

    const outcome = await service.run('site-a', 'tenant-a');
    const writes = client.query.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO weather_investigation_findings'),
    );
    expect(outcome.createdOrUpdated).toBe(2);
    expect(writes).toHaveLength(2);
    const keys = writes.map(([, args]) => String(args?.[3]));
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0].slice(0, 15)).toBe(keys[1].slice(0, 15));
    expect(keys.every((key) => key.startsWith('rain:'))).toBe(true);
  });

  it('preserves the previous identity when a forecast episode shifts but overlaps', async () => {
    process.env = { ...original };
    const start = futureSameDayIndex();
    const { service, client, weather } = setup(
      rainEpisodeProvider([[start + 1, start + 2]]),
    );
    const data = rainSnapshot([start + 1, start + 2]);
    weather.getSnapshotForLocation.mockResolvedValue(data);
    const legacyKey = `rain:${data.hourly[start].time!.slice(0, 10)}`;
    const baseQuery = client.query.getMockImplementation()!;
    client.query.mockImplementation(async (sql, args = []) => {
      if (String(sql).includes('SELECT stable_key AS "stableKey"')) {
        return {
          rows: [{
            stableKey: legacyKey,
            eventType: 'rain',
            location: 'Vidin',
            startsAt: new Date(data.hourly[start].time!),
            endsAt: new Date(Date.parse(data.hourly[start + 1].time!) + 3_600_000),
          }],
          rowCount: 1,
        };
      }
      return baseQuery(sql, args);
    });

    await service.run('site-a', 'tenant-a');
    const write = client.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO weather_investigation_findings'),
    );
    expect(write?.[1]?.[3]).toBe(legacyKey);
  });

  it('does not recycle an old same-day event key for a separate later episode', async () => {
    process.env = { ...original };
    const start = futureSameDayIndex();
    const { service, client, weather } = setup(
      rainEpisodeProvider([[start + 2, start + 2]]),
    );
    const data = rainSnapshot([start + 2]);
    weather.getSnapshotForLocation.mockResolvedValue(data);
    const legacyKey = `rain:${data.hourly[start].time!.slice(0, 10)}`;
    const baseQuery = client.query.getMockImplementation()!;
    client.query.mockImplementation(async (sql, args = []) => {
      if (String(sql).includes('SELECT stable_key AS "stableKey"')) {
        return {
          rows: [{
            stableKey: legacyKey,
            eventType: 'rain',
            location: 'Vidin',
            startsAt: data.hourly[start].time,
            endsAt: data.hourly[start + 1].time,
          }],
          rowCount: 1,
        };
      }
      return baseQuery(sql, args);
    });

    await service.run('site-a', 'tenant-a');
    const write = client.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO weather_investigation_findings'),
    );
    expect(write?.[1]?.[3]).not.toBe(legacyKey);
    expect(String(write?.[1]?.[3])).toContain(data.hourly[start + 2].time);
  });

  it('does not fabricate delivery times and does not prune referenced evidence', async () => {
    process.env = { ...original };
    const { service, client } = setup();
    await service.run('site-a', 'tenant-a');
    const sql = client.query.mock.calls.map(([statement]) => String(statement));
    const write = sql.find((statement) => statement.includes('INSERT INTO weather_investigation_findings'))!;
    expect(write).not.toContain('first_notified_at');
    const prune = sql.find((statement) => statement.includes('DELETE FROM weather_investigation_snapshots'))!;
    expect(prune).toContain('NOT EXISTS');
    expect(prune).toContain('f.evidence_snapshot_id=s.id');
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
