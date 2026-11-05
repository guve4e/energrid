import { AppdDanubeProviderService } from './appd-danube-provider.service';
import { DanubePortalProviderService } from './danube-portal-provider.service';
import { RiverHistoryService } from './river-history.service';
import { RiverForecastRecorderService } from './forecast-monitoring/river-forecast-recorder.service';
import { RiverStationReading } from './river.types';

const row = (cells: string[]) =>
  `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;

describe('River observation timestamps', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('keeps APPD publication date separate from observation time and river kilometre from elevation', async () => {
    const html = '<h2>Water levels on the bulgarian section of the Danube river 05.11.2026 г.</h2>' +
      row(['Vidin', '790.30', '-7', '', '+2', '13.7']);
    global.fetch = jest.fn().mockResolvedValue(new Response(html)) as typeof fetch;

    const [vidin] = await new AppdDanubeProviderService().getStations();
    expect(vidin).toMatchObject({
      station: 'Vidin', provider: 'appd-bg', levelCm: -7,
      riverKm: 790.3, elevationM: null,
      observedAt: null, sourceReportedAt: '05.11.2026', observationTimeBasis: 'date-only',
    });
    expect(Number.isFinite(Date.parse(vidin.fetchedAt))).toBe(true);
  });

  it('never interprets DanubePortal local-looking time as UTC or fetch time', async () => {
    const html = row(['Calafat', 'Dunărea', '0795', '2026-11-05 05:00', '-149', '']);
    global.fetch = jest.fn().mockResolvedValue(new Response(html)) as typeof fetch;

    const [reading] = await new DanubePortalProviderService().getStations();
    expect(reading).toMatchObject({
      station: 'Calafat', levelCm: -149, riverKm: 795, elevationM: null,
      sourceReportedAt: '2026-11-05 05:00', observationTimeBasis: 'timezone-unverified',
      observedAt: null,
    });
    expect(reading.fetchedAt).not.toBe('2026-11-05T05:00:00.000Z');
  });

  it('does not replace an invalid provider timestamp with the current time', async () => {
    const html = row(['Calafat', 'Dunărea', '0795', 'not a date', '-149', '']);
    global.fetch = jest.fn().mockResolvedValue(new Response(html)) as typeof fetch;
    const [reading] = await new DanubePortalProviderService().getStations();
    expect(reading.observedAt).toBeNull();
    expect(reading.sourceReportedAt).toBe('not a date');
  });

  it('does not insert repeated unverified polls into historical observations', async () => {
    const query = jest.fn();
    const history = new RiverHistoryService({ query } as never, {} as never);
    const reading: RiverStationReading = {
      station: 'Vidin', provider: 'appd-bg', levelCm: 100, elevationM: null,
      riverKm: 790.3, dischargeM3s: null, difference24hCm: null,
      trend: 'unknown', waterTempC: null,
      fetchedAt: new Date().toISOString(), observedAt: null,
      sourceReportedAt: '05.11.2026', observationTimeBasis: 'date-only',
    };
    expect(await history.saveReadings([reading, { ...reading }])).toEqual({
      processed: 0, skippedUnverified: 2,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('uses verified observation time for the existing hourly uniqueness key', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 1 });
    const history = new RiverHistoryService({ query } as never, {} as never);
    const reading: RiverStationReading = {
      station: 'Vidin', provider: 'test-verified-gauge', levelCm: 100,
      elevationM: null, riverKm: null, dischargeM3s: null,
      difference24hCm: null, trend: 'stable', waterTempC: null,
      fetchedAt: '2026-11-05T12:30:00Z', observedAt: new Date(Date.now() - 60_000).toISOString(),
      sourceReportedAt: '2026-11-05T11:00:00Z', observationTimeBasis: 'verified',
    };
    expect(await history.saveReadings([reading])).toEqual({ processed: 1, skippedUnverified: 0 });
    expect(query.mock.calls[0][1][8]).toBe(reading.observedAt);
    expect(query.mock.calls[0][0]).toContain("date_trunc('hour', $9::timestamptz)");
  });

  it('rejects a timezone-free value even when incorrectly labeled verified', async () => {
    const query = jest.fn();
    const history = new RiverHistoryService({ query } as never, {} as never);
    const reading: RiverStationReading = {
      station: 'Vidin', provider: 'test', levelCm: 100,
      elevationM: null, riverKm: null, dischargeM3s: null,
      difference24hCm: null, trend: 'unknown', waterTempC: null,
      fetchedAt: new Date().toISOString(), observedAt: '2026-11-05 05:00',
      sourceReportedAt: '2026-11-05 05:00', observationTimeBasis: 'verified',
    };
    expect(await history.saveReadings([reading])).toEqual({ processed: 0, skippedUnverified: 1 });
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses to record river predictions from unverified live measurements', async () => {
    const query = jest.fn();
    const recorder = new RiverForecastRecorderService({ query } as never);
    const result = await recorder.recordDashboardForecasts({
      mainStation: { station: 'Vidin', provider: 'appd-bg', levelCm: 100,
        fetchedAt: new Date().toISOString(), observedAt: null, observationTimeBasis: 'date-only' },
      forecast: { projection: { next6h: { expectedCm: 110 } } },
    });
    expect(result).toMatchObject({ recorded: 0, skipped: true, reason: 'unverified-observation-time' });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('River forecast admission', () => {
  it('does not build a level projection from an unverified current station time', async () => {
    const { RiverService } = require('./river.service');
    const current = {
      station: 'Vidin', provider: 'appd-bg', levelCm: 110, fetchedAt: new Date().toISOString(),
      observedAt: null, observationTimeBasis: 'date-only', difference24hCm: 4,
      dischargeM3s: null,
    };
    const forecast = { generate: jest.fn() };
    const service = new RiverService(
      { getStations: jest.fn().mockResolvedValue([current]) } as never,
      { getStations: jest.fn().mockResolvedValue([]) } as never,
      { analyze: jest.fn().mockReturnValue({ mainStation: current, intelligence: {} }) } as never,
      {
        getRecent: jest.fn().mockResolvedValue([{ levelCm: 100 }, { levelCm: 110 }]),
        getTrendSummary: jest.fn().mockResolvedValue({ historyTrend: 'rising' }),
      } as never,
      { normalize: jest.fn().mockReturnValue([]) } as never,
      forecast as never,
      { find: jest.fn().mockReturnValue(null) } as never,
    );
    const dashboard = await service.getDanubeDashboard();
    expect(dashboard.forecast).toBeNull();
    expect(dashboard.regionalPropagationForecast).toBeNull();
    expect(forecast.generate).not.toHaveBeenCalled();
  });
});


describe('River intelligence with unverified time', () => {
  it('shows the measured level without inventing a next-day trend or safety assessment', () => {
    const { RiverIntelligenceService } = require('./river-intelligence.service');
    const result = new RiverIntelligenceService().analyze({
      station: 'Vidin', provider: 'appd-bg', levelCm: -7, fetchedAt: new Date().toISOString(),
      observedAt: null, observationTimeBasis: 'date-only', difference24hCm: 25,
    }, [], { historyTrend: 'rising', points: 40 });
    expect(result.mainStation.levelCm).toBe(-7);
    expect(result.intelligence).toMatchObject({
      next24h: 'unknown', confidence: 'low', navigationRisk: 'unknown', boatRisk: 'unknown',
    });
    expect(result.intelligence.headline).toContain('unverified');
  });
});
