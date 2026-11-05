import { RiverCollectorService } from './river-collector.service';
import { RiverSourceObservationStore } from './river-source-observation.store';
import { RiverStationReading } from './river.types';

const reading = (overrides: Partial<RiverStationReading> = {}): RiverStationReading => ({
  station: 'Vidin', provider: 'appd-bg', levelCm: -7,
  riverKm: 790.3, elevationM: null, dischargeM3s: null,
  difference24hCm: 2, trend: 'stable', waterTempC: 13.7,
  fetchedAt: '2026-11-05T09:00:00.000Z', observedAt: null,
  sourceReportedAt: '05.11.2026', observationTimeBasis: 'date-only',
  ...overrides,
});

describe('River source evidence archive', () => {
  it('retains provider time as text, leaving exact observation time unknown', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ inserted: true }] });
    const store = new RiverSourceObservationStore({ query } as never);
    expect(await store.record([reading()])).toEqual({ inserted: 1, seenAgain: 0, rejected: 0 });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO river_source_observations');
    expect(sql).not.toContain('INSERT INTO river_readings');
    expect(params[3]).toBe('05.11.2026');
    expect(params[4]).toBeNull();
    expect(params[5]).toBe('date-only');
    expect(params[6]).toBe(790.3);
    expect(params[13]).toBe('2026-11-05T09:00:00.000Z');
  });

  it('deduplicates matching source evidence regardless of fetch instant', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ inserted: true }] })
      .mockResolvedValueOnce({ rows: [{ inserted: false }] });
    const store = new RiverSourceObservationStore({ query } as never);
    const first = reading();
    const later = reading({ fetchedAt: '2026-11-05T10:00:00.000Z' });
    expect(await store.record([first, later])).toEqual({ inserted: 1, seenAgain: 1, rejected: 0 });
    expect(query.mock.calls[0][1][0]).toBe(query.mock.calls[1][1][0]);
    expect(query.mock.calls[0][0]).toContain('poll_count = river_source_observations.poll_count + 1');
  });

  it('retains source revisions as distinct evidence', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ inserted: true }] });
    const store = new RiverSourceObservationStore({ query } as never);
    await store.record([reading(), reading({ levelCm: -8 })]);
    expect(query.mock.calls[0][1][0]).not.toBe(query.mock.calls[1][1][0]);
  });

  it('rejects fabricated instants, future fetches and non-finite measurements', async () => {
    const query = jest.fn();
    const store = new RiverSourceObservationStore({ query } as never);
    expect(await store.record([
      reading({ observedAt: '2026-11-05 07:00' }),
      reading({ observationTimeBasis: 'verified', observedAt: null }),
      reading({ fetchedAt: '2099-01-01T10:00:00.000Z' }),
      reading({ dischargeM3s: Number.NaN }),
    ])).toEqual({ inserted: 0, seenAgain: 0, rejected: 4 });
    expect(query).not.toHaveBeenCalled();
  });

  it('queries source evidence separately from trusted hourly history', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ station: 'Vidin', observationTimeBasis: 'date-only' }] });
    const store = new RiverSourceObservationStore({ query } as never);
    const result = await store.getRecent('Vidin', 10000);
    expect(result).toHaveLength(1);
    expect(query.mock.calls[0][0]).toContain('FROM river_source_observations');
    expect(query.mock.calls[0][1]).toEqual(['Vidin', 500]);
  });

  it('collects source evidence without treating it as verified history', async () => {
    const appd = { getStations: jest.fn().mockResolvedValue([reading()]) };
    const portal = { getStations: jest.fn().mockResolvedValue([]) };
    const source = { record: jest.fn().mockResolvedValue({ inserted: 1, seenAgain: 0, rejected: 0 }) };
    const history = { saveReadings: jest.fn().mockResolvedValue({ processed: 0, skippedUnverified: 1 }) };
    const collector = new RiverCollectorService(appd as never, portal as never, history as never, source as never);
    const prior = process.env.RIVER_SOURCE_EVIDENCE_ENABLED;
    process.env.RIVER_SOURCE_EVIDENCE_ENABLED = 'true';
    let result;
    try { result = await collector.collectNow(); }
    finally {
      if (prior === undefined) delete process.env.RIVER_SOURCE_EVIDENCE_ENABLED;
      else process.env.RIVER_SOURCE_EVIDENCE_ENABLED = prior;
    }
    expect(source.record).toHaveBeenCalledWith([reading()]);
    expect(history.saveReadings).toHaveBeenCalledWith([reading()]);
    expect(result).toMatchObject({ processed: 0, skippedUnverified: 1,
      sourceEvidence: { inserted: 1, seenAgain: 0, rejected: 0 } });
  });

  it('keeps the existing collector working before the evidence migration is enabled', async () => {
    const prior = process.env.RIVER_SOURCE_EVIDENCE_ENABLED;
    delete process.env.RIVER_SOURCE_EVIDENCE_ENABLED;
    const source = { record: jest.fn() };
    const collector = new RiverCollectorService(
      { getStations: jest.fn().mockResolvedValue([reading()]) } as never,
      { getStations: jest.fn().mockResolvedValue([]) } as never,
      { saveReadings: jest.fn().mockResolvedValue({ processed: 0, skippedUnverified: 1 }) } as never,
      source as never,
    );
    try {
      const result = await collector.collectNow();
      expect(result.sourceEvidence).toEqual({ status: 'disabled' });
      expect(source.record).not.toHaveBeenCalled();
    } finally {
      if (prior !== undefined) process.env.RIVER_SOURCE_EVIDENCE_ENABLED = prior;
    }
  });
});
