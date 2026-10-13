import { Pool } from 'pg';
import { TelemetryStore, storedReading } from './telemetry.store';
import { testReading, testStoredRow } from './telemetry-test.fixture';

const setup = () => {
  const client = {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: jest.fn(),
  };
  const pool = {
    connect: jest.fn().mockResolvedValue(client),
    query: jest.fn(),
    end: jest.fn(),
  };
  return { client, pool, store: new TelemetryStore(pool as unknown as Pool) };
};
const stream = {
  tenantId: 'tenant-demo',
  siteId: 'site-home',
  deviceId: 'meter',
  channel: 'em1:0',
  metric: 'power' as const,
};
const from = '2026-10-11T01:00:00.000Z',
  to = '2026-10-11T02:00:00.000Z';

describe('PostgreSQL reading repository', () => {
  it('inserts a reading and queues adjacent affected hours in the same transaction', async () => {
    const { store, client } = setup();
    client.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [testStoredRow()], rowCount: 1 });
    expect(await store.append(testReading())).toBe('stored');
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO telemetry.readings'),
      expect.stringContaining('INSERT INTO telemetry.dirty_hours'),
      'COMMIT',
    ]);
    expect(client.query.mock.calls[1][1]).toEqual([
      ...Object.values(stream),
      3000,
      'W',
      'measured',
      from,
      testReading().receivedAt,
      'device-observed',
      'shelly',
    ]);
    expect(client.query.mock.calls[2][0]).toContain("interval '5 minutes'");
    expect(client.release).toHaveBeenCalled();
  });
  it('treats an identical replay as a duplicate without double-queuing or rewriting', async () => {
    const { store, client } = setup();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [testStoredRow()] });
    expect(
      await store.append(testReading({ receivedAt: '2026-10-11T01:00:02Z' })),
    ).toBe('duplicate');
    expect(client.query).toHaveBeenCalledTimes(4);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });
  it.each([
    { value: 1 },
    { quality: 'invalid' },
    { unit: 'kWh' },
    { source: 'different' },
    { timestamp_basis: 'collector-received' },
  ])(
    'rejects conflicting replays without changing the original %j',
    async (patch) => {
      const { store, client } = setup();
      client.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [testStoredRow(patch)] });
      await expect(store.append(testReading())).rejects.toThrow('Conflicting');
      expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
      expect(client.release).toHaveBeenCalled();
    },
  );
  it('rolls back if queuing fails, so saved readings cannot silently lack summary work', async () => {
    const { store, client } = setup();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockRejectedValueOnce(new Error('db unavailable'));
    await expect(store.append(testReading())).rejects.toThrow();
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
  it('validates before touching the database', async () => {
    const { store, pool } = setup();
    await expect(store.append(testReading({ value: NaN }))).rejects.toThrow();
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it('reads only a fully scoped stream with bounded anchors and a hard row cap', async () => {
    const { store, pool } = setup();
    pool.query.mockResolvedValue({ rows: [testStoredRow()] });
    expect(await store.read(stream, from, to)).toEqual([testReading()]);
    expect(pool.query.mock.calls[0][1]).toEqual([
      ...Object.values(stream),
      from,
      to,
    ]);
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain(
      'tenant_id=$1 AND site_id=$2 AND device_id=$3 AND channel=$4 AND metric=$5',
    );
    expect(sql).toContain('LIMIT 100001');
    expect(sql).toContain("interval '5 minutes'");
  });
  it('rejects oversized ranges even when no boundary anchors exist', async () => {
    const { store, pool } = setup();
    pool.query.mockResolvedValue({ rows: Array(100001).fill(testStoredRow()) });
    await expect(store.read(stream, from, to)).rejects.toThrow('Too many');
  });
  it('returns stored rollups with their refresh time', async () => {
    const { store, pool } = setup();
    pool.query.mockResolvedValue({
      rows: [
        {
          statistics: { hour: from, sampleCount: 1 },
          updated_at: new Date(to),
        },
      ],
    });
    expect(await store.hourly(stream, from, to)).toEqual([
      { hour: from, sampleCount: 1, updatedAt: to },
    ]);
    expect(pool.query.mock.calls[0][1]).toEqual([
      ...Object.values(stream),
      from,
      to,
    ]);
  });
  it('maps and validates stored rows rather than leaking database fields', () => {
    expect(storedReading(testStoredRow())).toEqual(testReading());
    expect(() => storedReading(testStoredRow({ unit: 'bad' }))).toThrow();
  });
  it('fails explicitly when disabled and closes its pool', async () => {
    const store = new TelemetryStore(null);
    await expect(store.append(testReading())).rejects.toThrow('disabled');
    await expect(store.read(stream, from, to)).rejects.toThrow('disabled');
    await expect(store.hourly(stream, from, to)).rejects.toThrow('disabled');
    await expect(store.refreshOneHour()).rejects.toThrow('disabled');
    await store.close();
    const enabled = setup();
    await enabled.store.close();
    expect(enabled.pool.end).toHaveBeenCalled();
  });
});

describe('durable, repeatable hourly work', () => {
  it('claims work with a database lock, rebuilds the bucket, and deletes work only on success', async () => {
    const { store, client } = setup();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ ...testStoredRow(), hour: new Date(from) }],
      })
      .mockResolvedValueOnce({
        rows: [
          testStoredRow(),
          testStoredRow({ observed_at: new Date('2026-10-11T01:05:00Z') }),
        ],
      });
    expect(await store.refreshOneHour()).toBe(true);
    expect(client.query.mock.calls[1][0]).toContain('FOR UPDATE SKIP LOCKED');
    const upsert = client.query.mock.calls[3];
    expect(upsert[0]).toContain('DO UPDATE SET statistics=EXCLUDED.statistics');
    expect(JSON.parse(upsert[1][6])).toEqual(
      expect.objectContaining({
        estimatedImportKwh: 0.25,
        coveredSeconds: 300,
      }),
    );
    expect(client.query.mock.calls[4][0]).toContain(
      'DELETE FROM telemetry.dirty_hours',
    );
    expect(client.query.mock.calls[5][0]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });
  it('returns idle without querying readings if there is no dirty hour', async () => {
    const { store, client } = setup();
    expect(await store.refreshOneHour()).toBe(false);
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });
  it('preserves work through rollback when rebuilding fails', async () => {
    const { store, client } = setup();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ ...testStoredRow(), hour: new Date(from) }],
      })
      .mockRejectedValueOnce(new Error('unavailable'));
    await expect(store.refreshOneHour()).rejects.toThrow();
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(
      client.query.mock.calls.some(([sql]) => sql.includes('DELETE')),
    ).toBe(false);
  });
  it('will not silently truncate a dense hour', async () => {
    const { store, client } = setup();
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ ...testStoredRow(), hour: new Date(from) }],
      })
      .mockResolvedValueOnce({ rows: Array(100001).fill(testStoredRow()) });
    await expect(store.refreshOneHour()).rejects.toThrow('Too many');
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});
