import { WeatherObservationCollector } from './weather-observation-collector.service';
import { WeatherCoordinates } from './weather-observations';

const originalEnv = process.env;
const now = new Date('2026-11-06T10:00:00.000Z');

const places: Array<{
  label: string;
  target: WeatherCoordinates;
  closestStation: WeatherCoordinates;
  selectedStation: WeatherCoordinates;
}> = [
  {
    label: 'Vidin, Bulgaria',
    target: { latitude: 43.9916, longitude: 22.8728 },
    closestStation: { latitude: 43.997, longitude: 22.8728 },
    selectedStation: { latitude: 44.03, longitude: 22.8728 },
  },
  {
    label: 'Lincoln, Nebraska, USA',
    target: { latitude: 40.8136, longitude: -96.7026 },
    closestStation: { latitude: 40.82, longitude: -96.7026 },
    selectedStation: { latitude: 40.86, longitude: -96.7026 },
  },
];

function configure() {
  process.env = {
    ...originalEnv,
    WEATHER_OBSERVATION_PROVIDER: 'meteostat',
    WEATHER_OBSERVATION_COLLECTION_ENABLED: 'true',
    METEOSTAT_INTERVAL_LABEL: 'end',
    METEOSTAT_NEARBY_RADIUS_KM: '25',
    METEOSTAT_NEARBY_STATION_LIMIT: '3',
    METEOSTAT_INTERVAL_VERIFIED_STATION_IDS: 'CLOSE1,RAIN2',
    METEOSTAT_API_KEY: 'fixture-only-key',
  };
  delete process.env.METEOSTAT_STATION_ID;
}

function response(data: unknown): Response {
  return { ok: true, json: async () => ({ data }) } as Response;
}

function station(id: string, coordinates: WeatherCoordinates) {
  return {
    id,
    name: { en: id },
    country: 'XX',
    region: 'R1',
    timezone: 'UTC',
    location: coordinates,
    identifiers: { national: `national-${id}` },
    inventory: { hourly: { start: '2020-01-01', end: '2026-11-06' } },
  };
}

afterEach(() => {
  process.env = originalEnv;
  jest.restoreAllMocks();
});

describe('coordinate-based station precipitation collection', () => {
  it.each(places)(
    'selects a usable actual station near $label',
    async (place) => {
      configure();
      const ingest = jest.fn().mockResolvedValue({ recorded: 2 });
      const store = {
        claimCollection: jest.fn().mockResolvedValue({ claimed: true }),
        saveCollectionStatus: jest.fn().mockResolvedValue(undefined),
      };
      const fetch = jest
        .spyOn(global, 'fetch')
        .mockImplementation(async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith('/nearby'))
            return response([
              { id: 'CLOSE1', distance: 600 },
              { id: 'CLOSE1', distance: 600 },
              { id: 'RAIN2', distance: 4300 },
            ]);
          if (url.pathname.endsWith('/meta')) {
            return response(
              url.searchParams.get('id') === 'CLOSE1'
                ? station('CLOSE1', place.closestStation)
                : station('RAIN2', place.selectedStation),
            );
          }
          const stationId = url.searchParams.get('station');
          return response(
            stationId === 'CLOSE1'
              ? [{ time: '2026-11-06 09:00:00', prcp: 0 }]
              : [
                  { time: '2026-11-06 09:00:00', prcp: 0 },
                  { time: '2026-11-06 10:00:00', prcp: 2 },
                ],
          );
        });
      const collector = new WeatherObservationCollector(
        { ingest } as never,
        store as never,
      );
      const result = await collector.collectAtCoordinates(
        {
          ...place.target,
          metric: 'precipitation_mm',
          startAt: '2026-11-06T08:00:00.000Z',
          endAt: '2026-11-06T10:00:00.000Z',
        },
        now,
      );

      expect(result).toMatchObject({
        status: 'available',
        source: expect.stringContaining('meteostat:RAIN2@'),
        station: {
          id: 'RAIN2',
          latitude: place.selectedStation.latitude,
          longitude: place.selectedStation.longitude,
        },
        coverage: {
          expectedHours: 2,
          observedHours: 2,
          missingHours: 0,
          complete: true,
        },
        attribution: expect.stringContaining(
          'original data provider is not identified',
        ),
      });
      expect(result.station?.distanceKm).toBeGreaterThan(0);
      expect(result.station?.reportedDistanceKm).toBeCloseTo(4.3);
      expect(ingest).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(5);
      expect(ingest.mock.calls[0][0]).toContain('RAIN2@');
      expect(ingest.mock.calls[0][1]).toBe(
        `${place.target.latitude.toFixed(5)},${place.target.longitude.toFixed(5)}`,
      );
      expect(ingest.mock.calls[0][2]).toEqual([
        {
          metric: 'precipitation_mm',
          value: 0,
          observedAt: '2026-11-06T09:00:00.000Z',
          windowStartAt: '2026-11-06T08:00:00.000Z',
        },
        {
          metric: 'precipitation_mm',
          value: 2,
          observedAt: '2026-11-06T10:00:00.000Z',
          windowStartAt: '2026-11-06T09:00:00.000Z',
        },
      ]);
      const nearbyRequest = new URL(String(fetch.mock.calls[0][0]));
      expect(nearbyRequest.pathname).toBe('/stations/nearby');
      expect(nearbyRequest.searchParams.get('lat')).toBe(
        String(place.target.latitude),
      );
      expect(nearbyRequest.searchParams.get('lon')).toBe(
        String(place.target.longitude),
      );
      const hourlyRequest = new URL(String(fetch.mock.calls.at(-1)?.[0]));
      expect(hourlyRequest.pathname).toBe('/stations/hourly');
      expect(hourlyRequest.searchParams.get('model')).toBe('false');
      expect(hourlyRequest.searchParams.get('units')).toBe('metric');
      expect(hourlyRequest.searchParams.get('tz')).toBe('UTC');
      expect(hourlyRequest.searchParams.get('start')).toBe('2026-11-06');
      expect(hourlyRequest.searchParams.get('end')).toBe('2026-11-06');
      expect(JSON.stringify(result)).not.toContain('fixture-only-key');
    },
  );

  it('reports unavailable when metadata shows no coverage and never calls point data', async () => {
    configure();
    const ingest = jest.fn();
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(response([{ id: 'OLD01', distance: 1000 }]))
      .mockResolvedValueOnce(
        response({
          ...station('OLD01', { latitude: 43.99, longitude: 22.87 }),
          inventory: { hourly: { start: '2000-01-01', end: '2020-01-01' } },
        }),
      );
    const collector = new WeatherObservationCollector(
      { ingest } as never,
      {
        claimCollection: jest.fn().mockResolvedValue({ claimed: true }),
        saveCollectionStatus: jest.fn(),
      } as never,
    );
    const result = await collector.collectAtCoordinates(
      {
        latitude: 43.9916,
        longitude: 22.8728,
        metric: 'precipitation_mm',
        startAt: '2026-11-06T08:00:00.000Z',
        endAt: '2026-11-06T10:00:00.000Z',
      },
      now,
    );
    expect(result).toMatchObject({ status: 'unavailable' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0][0])).not.toContain('/point/');
    expect(ingest).not.toHaveBeenCalled();
  });

  it('uses bounded configurable nearby radius and candidate count', async () => {
    configure();
    process.env.METEOSTAT_NEARBY_RADIUS_KM = '8';
    process.env.METEOSTAT_NEARBY_STATION_LIMIT = '2';
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(response([]));
    const collector = new WeatherObservationCollector(
      {} as never,
      {
        claimCollection: jest.fn().mockResolvedValue({ claimed: true }),
        saveCollectionStatus: jest.fn(),
      } as never,
    );
    const result = await collector.collectAtCoordinates(
      {
        latitude: 40.8136,
        longitude: -96.7026,
        metric: 'precipitation_mm',
        startAt: '2026-11-06T08:00:00.000Z',
        endAt: '2026-11-06T10:00:00.000Z',
      },
      now,
    );

    expect(result).toMatchObject({ status: 'unavailable' });
    const nearbyRequest = new URL(String(fetch.mock.calls[0][0]));
    expect(nearbyRequest.searchParams.get('radius')).toBe('8000');
    expect(nearbyRequest.searchParams.get('limit')).toBe('2');

    process.env.METEOSTAT_NEARBY_RADIUS_KM = '201';
    const invalid = await collector.collectAtCoordinates(
      {
        latitude: 40.8136,
        longitude: -96.7026,
        metric: 'precipitation_mm',
        startAt: '2026-11-06T08:00:00.000Z',
        endAt: '2026-11-06T10:00:00.000Z',
      },
      now,
    );
    expect(invalid).toMatchObject({ status: 'configuration-required' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stores only the reported hours when station coverage is partial', async () => {
    configure();
    process.env.METEOSTAT_INTERVAL_VERIFIED_STATION_IDS = 'PART1';
    const ingest = jest.fn().mockResolvedValue({ recorded: 1 });
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(response([{ id: 'PART1', distance: 1000 }]))
      .mockResolvedValueOnce(
        response(station('PART1', { latitude: 43.997, longitude: 22.8728 })),
      )
      .mockResolvedValueOnce(
        response([{ time: '2026-11-06 09:00:00', prcp: 0 }]),
      );
    const collector = new WeatherObservationCollector(
      { ingest } as never,
      {
        claimCollection: jest.fn().mockResolvedValue({ claimed: true }),
        saveCollectionStatus: jest.fn(),
      } as never,
    );
    const result = await collector.collectAtCoordinates(
      {
        latitude: 43.9916,
        longitude: 22.8728,
        metric: 'precipitation_mm',
        startAt: '2026-11-06T08:00:00.000Z',
        endAt: '2026-11-06T10:00:00.000Z',
      },
      now,
    );
    expect(result).toMatchObject({
      status: 'partial-coverage',
      records: 1,
      coverage: {
        expectedHours: 2,
        observedHours: 1,
        missingHours: 1,
        complete: false,
      },
    });
    expect(ingest.mock.calls[0][2]).toHaveLength(1);
    expect(ingest.mock.calls[0][2][0].value).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not score a station until its hourly interval label is verified for that station', async () => {
    configure();
    process.env.METEOSTAT_INTERVAL_VERIFIED_STATION_IDS = '';
    const ingest = jest.fn();
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(response([{ id: 'UNVER1', distance: 1000 }]))
      .mockResolvedValueOnce(
        response(station('UNVER1', { latitude: 43.997, longitude: 22.8728 })),
      );
    const collector = new WeatherObservationCollector(
      { ingest } as never,
      {
        claimCollection: jest.fn().mockResolvedValue({ claimed: true }),
        saveCollectionStatus: jest.fn(),
      } as never,
    );

    const result = await collector.collectAtCoordinates(
      {
        latitude: 43.9916,
        longitude: 22.8728,
        metric: 'precipitation_mm',
        startAt: '2026-11-06T08:00:00.000Z',
        endAt: '2026-11-06T10:00:00.000Z',
      },
      now,
    );

    expect(result).toMatchObject({
      status: 'reporting-period-unverified',
      station: {
        id: 'UNVER1',
        latitude: 43.997,
        longitude: 22.8728,
        distanceKm: expect.any(Number),
      },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('does not contact Meteostat for invalid coordinates or non-hour UTC windows', async () => {
    configure();
    const fetch = jest.spyOn(global, 'fetch');
    const collector = new WeatherObservationCollector({} as never, {} as never);
    const invalid = await collector.collectAtCoordinates(
      {
        latitude: 91,
        longitude: 0,
        metric: 'precipitation_mm',
        startAt: '2026-11-06T08:30:00.000Z',
        endAt: '2026-11-06T10:00:00.000Z',
      },
      now,
    );
    expect(invalid).toMatchObject({ status: 'unavailable' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns the prior status without repeating the same coordinate collection', async () => {
    configure();
    const previous = {
      status: 'available',
      source: 'meteostat:RAIN2@43.99160,22.87280:hourly-end',
      records: 2,
    };
    const store = {
      claimCollection: jest
        .fn()
        .mockResolvedValue({ claimed: false, snapshot: previous }),
      saveCollectionStatus: jest.fn(),
    };
    const fetch = jest.spyOn(global, 'fetch');
    const collector = new WeatherObservationCollector(
      {} as never,
      store as never,
    );
    const result = await collector.collectAtCoordinates(
      {
        latitude: 43.9916,
        longitude: 22.8728,
        metric: 'precipitation_mm',
        startAt: '2026-11-06T08:00:00.000Z',
        endAt: '2026-11-06T10:00:00.000Z',
      },
      now,
    );
    expect(result).toMatchObject(previous);
    expect(fetch).not.toHaveBeenCalled();
    expect(store.saveCollectionStatus).not.toHaveBeenCalled();
  });

  it('turns API failures into an explicit sanitized unavailable result', async () => {
    configure();
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'secret failure body',
    } as Response);
    const collector = new WeatherObservationCollector(
      {} as never,
      {
        claimCollection: jest.fn().mockResolvedValue({ claimed: true }),
        saveCollectionStatus: jest.fn(),
      } as never,
    );
    const result = await collector.collectAtCoordinates(
      {
        latitude: 40.8136,
        longitude: -96.7026,
        metric: 'precipitation_mm',
        startAt: '2026-11-06T08:00:00.000Z',
        endAt: '2026-11-06T10:00:00.000Z',
      },
      now,
    );
    expect(result).toMatchObject({ status: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('reports missing development credentials without sending a request', async () => {
    configure();
    delete process.env.METEOSTAT_API_KEY;
    const fetch = jest.spyOn(global, 'fetch');
    const collector = new WeatherObservationCollector({} as never, {} as never);
    const result = await collector.collectAtCoordinates(
      {
        latitude: 40.8136,
        longitude: -96.7026,
        metric: 'precipitation_mm',
        startAt: '2026-11-06T08:00:00.000Z',
        endAt: '2026-11-06T10:00:00.000Z',
      },
      now,
    );
    expect(result).toMatchObject({ status: 'configuration-required' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('inspects an unapproved station without storing or scoring its raw evidence', async () => {
    configure();
    const ingest = jest.fn();
    const store = {
      claimCollection: jest.fn(),
      saveCollectionStatus: jest.fn(),
    };
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        response([
          { id: 'UNAPPROVED1', distance: 1200 },
          { id: 'UNAPPROVED1', distance: 1200 },
        ]),
      )
      .mockResolvedValueOnce(
        response(
          station('UNAPPROVED1', { latitude: 43.998, longitude: 22.8728 }),
        ),
      )
      .mockResolvedValueOnce(
        response([
          { time: '2026-02-30 09:00:00', prcp: 1 },
          { time: '2026-11-06 07:00:00', prcp: 4 },
          { time: '2026-11-06 08:00:00', prcp: 0 },
          { time: '2026-11-06 09:00:00', prcp: null },
          { time: '2026-11-06 09:30:00', prcp: 'missing' },
          { time: '2026-11-06 10:00:00', prcp: 2 },
        ]),
      );
    const collector = new WeatherObservationCollector(
      { ingest } as never,
      store as never,
    );

    const result = await collector.diagnoseAtCoordinates(
      {
        latitude: 43.9916,
        longitude: 22.8728,
        metric: 'precipitation_mm',
        startAt: '2026-11-06T08:00:00.000Z',
        endAt: '2026-11-06T10:00:00.000Z',
      },
      now,
    );

    expect(result).toMatchObject({
      status: 'available',
      interval: { requestedHours: 2 },
      stations: [
        {
          stationId: 'UNAPPROVED1',
          status: 'inspected',
          returnedRows: 6,
          validTimestampRows: 5,
          invalidTimestampRows: 1,
          uniqueTimestampLabels: 5,
          timestampRowsInRequestedInterval: 3,
          precipitationValues: 4,
          missingPrecipitationValues: 1,
          explicitZeroValues: 1,
          invalidPrecipitationValues: 1,
          intervalPrecipitationValues: 1,
          intervalMissingPrecipitationValues: 1,
          intervalExplicitZeroValues: 1,
          intervalInvalidPrecipitationValues: 1,
          firstTimestampLabel: '2026-11-06 07:00:00',
          lastTimestampLabel: '2026-11-06 10:00:00',
        },
      ],
    });
    expect(result.note).toContain(
      'without assigning start/end interval semantics',
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    const hourlyRequest = new URL(String(fetch.mock.calls[2][0]));
    expect(hourlyRequest.pathname).toBe('/stations/hourly');
    expect(hourlyRequest.searchParams.get('model')).toBe('false');
    expect(hourlyRequest.searchParams.get('units')).toBe('metric');
    expect(hourlyRequest.searchParams.get('tz')).toBe('UTC');
    expect(ingest).not.toHaveBeenCalled();
    expect(store.claimCollection).not.toHaveBeenCalled();
    expect(store.saveCollectionStatus).not.toHaveBeenCalled();
  });

  it('bounds diagnostic intervals and does not call Meteostat without credentials', async () => {
    configure();
    const fetch = jest.spyOn(global, 'fetch');
    const collector = new WeatherObservationCollector({} as never, {} as never);
    const request = {
      latitude: 40.8136,
      longitude: -96.7026,
      metric: 'precipitation_mm' as const,
      startAt: '2026-10-30T07:00:00.000Z',
      endAt: '2026-11-06T08:00:00.000Z',
    };
    expect(await collector.diagnoseAtCoordinates(request, now)).toMatchObject({
      status: 'unavailable',
      stations: [],
    });
    expect(fetch).not.toHaveBeenCalled();

    delete process.env.METEOSTAT_API_KEY;
    expect(
      await collector.diagnoseAtCoordinates(
        { ...request, startAt: '2026-11-06T07:00:00.000Z' },
        now,
      ),
    ).toMatchObject({ status: 'configuration-required', stations: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports an unapproved station with no requested-period inventory as unavailable', async () => {
    configure();
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(response([{ id: 'OLD01', distance: 900 }]))
      .mockResolvedValueOnce(
        response({
          ...station('OLD01', { latitude: 43.99, longitude: 22.87 }),
          inventory: { hourly: { start: '2000-01-01', end: '2020-01-01' } },
        }),
      );
    const collector = new WeatherObservationCollector({} as never, {} as never);

    const result = await collector.diagnoseAtCoordinates(
      {
        latitude: 43.9916,
        longitude: 22.8728,
        metric: 'precipitation_mm',
        startAt: '2026-11-06T08:00:00.000Z',
        endAt: '2026-11-06T10:00:00.000Z',
      },
      now,
    );

    expect(result).toMatchObject({
      status: 'unavailable',
      stations: [
        {
          stationId: 'OLD01',
          reportedDistanceKm: 0.9,
          status: 'no-hourly-inventory',
        },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
