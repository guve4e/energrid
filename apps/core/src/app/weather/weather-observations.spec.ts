import {
  meteostatObservations,
  stationDistanceKm,
  weatherObservationSource,
} from './weather-observations';
import { WeatherObservationCollector } from './weather-observation-collector.service';

const now = new Date('2026-10-14T12:00:00Z');
const env = process.env;
const station = {
  id: '15502',
  name: { en: 'Vidin' },
  location: { latitude: 43.8167, longitude: 22.8833 },
};
const rows = [{ time: '2026-10-14 10:00:00', temp: 20, prcp: 0, wpgt: 30 }];
afterEach(() => {
  process.env = env;
  jest.restoreAllMocks();
});
function configured() {
  process.env = {
    ...env,
    WEATHER_OBSERVATION_PROVIDER: 'meteostat',
    WEATHER_OBSERVATION_COLLECTION_ENABLED: 'true',
    METEOSTAT_STATION_ID: '15502',
    METEOSTAT_INTERVAL_LABEL: 'end',
    METEOSTAT_API_KEY: 'test-secret',
  };
}
function collectionStore() {
  return {
    claimCollection: jest.fn().mockResolvedValue({ claimed: true }),
    saveCollectionStatus: jest.fn().mockResolvedValue(undefined),
    ingest: jest.fn(),
  };
}
describe('observation normalization', () => {
  it('keeps private sources separate and includes station and interval basis in automatic source identity', () => {
    expect(
      weatherObservationSource({ WEATHER_OBSERVATION_SOURCE: 'private' }),
    ).toBe('private');
    expect(
      weatherObservationSource({
        WEATHER_OBSERVATION_PROVIDER: 'meteostat',
        METEOSTAT_STATION_ID: '15502',
        METEOSTAT_INTERVAL_LABEL: 'end',
      }),
    ).toBe('meteostat:15502:hourly-end');
    expect(
      weatherObservationSource({
        WEATHER_OBSERVATION_PROVIDER: 'meteostat',
        METEOSTAT_STATION_ID: '15502',
      }),
    ).toBe('');
    expect(
      weatherObservationSource({
        WEATHER_OBSERVATION_PROVIDER: 'meteostat',
        METEOSTAT_STATION_ID: '../xx',
        METEOSTAT_INTERVAL_LABEL: 'end',
      }),
    ).toBe('');
  });
  it('keeps zero rain, instantaneous temperature and preceding interval gusts distinct', () => {
    expect(meteostatObservations(rows, 'end', now)).toEqual([
      {
        metric: 'temperature_c',
        value: 20,
        observedAt: '2026-10-14T10:00:00.000Z',
      },
      {
        metric: 'precipitation_mm',
        value: 0,
        observedAt: '2026-10-14T10:00:00.000Z',
        windowStartAt: '2026-10-14T09:00:00.000Z',
      },
      {
        metric: 'gust_kmh',
        value: 30,
        observedAt: '2026-10-14T10:00:00.000Z',
        windowStartAt: '2026-10-14T09:00:00.000Z',
      },
    ]);
  });
  it('supports explicitly verified start-labelled intervals without shifting temperature', () => {
    expect(meteostatObservations(rows, 'start', now)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: 'temperature_c',
          observedAt: '2026-10-14T10:00:00.000Z',
        }),
        expect.objectContaining({
          metric: 'precipitation_mm',
          observedAt: '2026-10-14T11:00:00.000Z',
          windowStartAt: '2026-10-14T10:00:00.000Z',
        }),
      ]),
    );
  });
  it('never turns missing, string, negative, future, old or invalid-date values into measurements', () => {
    expect(
      meteostatObservations(
        [
          { time: '2026-10-14 10:00:00', temp: null, prcp: '0', wpgt: -1 },
          { time: '2026-10-14 13:00:00', temp: 20, prcp: 2, wpgt: 30 },
          { time: '2026-09-01 10:00:00', temp: 20, prcp: 2, wpgt: 30 },
          { time: '2026-02-30 10:00:00', temp: 20 },
          { time: '2026-10-14 10:30:00', temp: 20 },
        ],
        'end',
        now,
      ),
    ).toEqual([]);
    expect(
      meteostatObservations(
        [{ time: '2026-10-14 12:00:00', temp: 20, prcp: 2 }],
        'start',
        now,
      ),
    ).toHaveLength(1);
  });
  it('deduplicates identical provider rows and rejects conflicting measurements', () => {
    expect(meteostatObservations([...rows, ...rows], 'end', now)).toHaveLength(
      3,
    );
    expect(() =>
      meteostatObservations([...rows, { ...rows[0], prcp: 3 }], 'end', now),
    ).toThrow('Conflicting');
  });
  it('exposes the real station distance, rather than calling it a measurement at the house', () => {
    expect(stationDistanceKm(43.9916, 22.8728)).toBe(0);
    expect(stationDistanceKm(43.8167, 22.8833)).toBeCloseTo(19.47, 1);
  });
});
describe('automatic observation collection', () => {
  it('does not contact external APIs when source, interval basis or key is missing', async () => {
    configured();
    delete process.env.METEOSTAT_API_KEY;
    const fetch = jest.spyOn(global, 'fetch');
    const ingest = jest.fn();
    const collector = new WeatherObservationCollector(
      { ingest } as never,
      collectionStore() as never,
    );
    expect(await collector.collect(now)).toMatchObject({
      status: 'configuration-required',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });
  it('requests station observations only, in UTC and metric, with bounded retries and private credentials', async () => {
    configured();
    const ingest = jest.fn().mockResolvedValue({ recorded: 1 });
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: station }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: rows }),
      } as Response);
    const collector = new WeatherObservationCollector(
      { ingest } as never,
      collectionStore() as never,
    );
    const result = await collector.collect(now);
    expect(result).toMatchObject({
      status: 'available',
      availableMetrics: ['temperature_c', 'precipitation_mm', 'gust_kmh'],
      station: { id: '15502' },
    });
    const request = new URL(String(fetch.mock.calls[1][0]));
    expect(request.searchParams.get('model')).toBe('false');
    expect(request.searchParams.get('tz')).toBe('UTC');
    expect(request.searchParams.get('units')).toBe('metric');
    expect(request.searchParams.get('start')).toBe('2026-09-30');
    expect(fetch.mock.calls[1][1]?.redirect).toBe('error');
    expect(ingest).toHaveBeenCalledWith(
      'meteostat:15502:hourly-end',
      '43.99160,22.87280',
      expect.any(Array),
    );
    expect(JSON.stringify(collector.status())).not.toContain('test-secret');
  });
  it('batches observations within the private ingestion limit', async () => {
    configured();
    const ingest = jest.fn().mockResolvedValue({ recorded: 1 });
    const data = Array.from({ length: 48 }, (_, i) => ({
      time: new Date(now.getTime() - (i + 1) * 3600000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' '),
      temp: 20,
      prcp: 1,
      wpgt: 20,
    }));
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: station }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data }),
      } as Response);
    await new WeatherObservationCollector(
      { ingest } as never,
      collectionStore() as never,
    ).collect(now);
    expect(ingest.mock.calls.map((call) => call[2].length)).toEqual([100, 44]);
  });
  it.each([
    { ...station, id: 'other' },
    { ...station, location: { latitude: 50, longitude: 20 } },
    { ...station, location: { latitude: NaN, longitude: 22 } },
  ])('rejects mismatched, remote or invalid station metadata', async (data) => {
    configured();
    const ingest = jest.fn();
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data }),
    } as Response);
    expect(
      await new WeatherObservationCollector(
        { ingest } as never,
        collectionStore() as never,
      ).collect(now),
    ).toMatchObject({ status: 'unavailable' });
    expect(ingest).not.toHaveBeenCalled();
  });
  it('reports empty and failed feeds without retaining the appearance of current measurements', async () => {
    configured();
    const ingest = jest.fn();
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: station }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      } as Response);
    const collector = new WeatherObservationCollector(
      { ingest } as never,
      collectionStore() as never,
    );
    expect(await collector.collect(now)).toMatchObject({
      status: 'no-observations',
      records: 0,
      lastObservedAt: null,
    });
    fetch.mockRejectedValue(new Error('secret upstream text'));
    const result = await collector.collect(
      new Date(now.getTime() + 24 * 3600000),
    );
    expect(result).toMatchObject({
      status: 'unavailable',
      lastSuccessAt: now.toISOString(),
    });
    expect(JSON.stringify(result)).not.toContain('secret upstream');
    expect(ingest).not.toHaveBeenCalled();
  });
  it('does not replace the existing private station adapter', async () => {
    process.env = { ...env, WEATHER_OBSERVATION_SOURCE: 'garden-station' };
    delete process.env.WEATHER_OBSERVATION_PROVIDER;
    const fetch = jest.spyOn(global, 'fetch');
    expect(
      await new WeatherObservationCollector(
        {} as never,
        collectionStore() as never,
      ).collect(now),
    ).toMatchObject({ status: 'manual', source: 'garden-station' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
