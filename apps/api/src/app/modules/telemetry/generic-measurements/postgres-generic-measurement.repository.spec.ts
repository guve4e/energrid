import type { Pool } from 'pg';
import { ConflictingMeasurementSampleError, PostgresGenericMeasurementRepository } from './postgres-generic-measurement.repository';
import type { GenericMeasurementInput } from '@energrid/domain-telemetry';

const input: GenericMeasurementInput = {
  tenantId: 'tenant-a', siteId: 'site-a', deviceId: 'device-a', physicalDeviceId: null,
  componentId: 'sensor', channel: 'environment', metric: 'temperature', unit: 'Cel',
  value: 20, quality: 'measured', source: 'approved-http-adapter',
  provenance: 'binding-1', sampleId: 'sample-1',
  observedAt: '2026-10-23T12:00:00.000Z', receivedAt: '2026-10-23T12:00:01.000Z',
};

function poolFor(query: jest.Mock) {
  const client = { query, release: jest.fn() };
  return {
    connect: jest.fn().mockResolvedValue(client),
    query: jest.fn(),
    client,
  } as unknown as Pool & { client: typeof client };
}

describe('PostgresGenericMeasurementRepository', () => {
  it('validates before writing and inserts with full tenant/site/sample identity', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ sample_id: 'sample-1' }] });
    const pool = poolFor(query);
    const repository = new PostgresGenericMeasurementRepository(pool);

    await expect(repository.append(input)).resolves.toBe('stored');
    expect(query.mock.calls[1][0]).toContain('INSERT INTO telemetry.measurements');
    expect(query.mock.calls[1][1]).toEqual([
      'tenant-a', 'site-a', 'device-a', null, 'sensor', 'environment', 'temperature',
      'Cel', 20, 'measured', 'approved-http-adapter', 'binding-1', 'sample-1',
      '2026-10-23T12:00:00.000Z', '2026-10-23T12:00:01.000Z',
    ]);
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');

    await expect(repository.append({ ...input, unit: 'F' })).rejects.toThrow('Unsupported measurement metric/unit pair');
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('returns duplicate only when the prior sample is the same and rejects reused identities with changed data', async () => {
    const existing = {
      physical_device_id: null, unit: 'Cel', value: 20, quality: 'measured',
      source: 'approved-http-adapter', provenance: 'binding-1',
      observed_at: new Date(input.observedAt),
    };
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // INSERT conflict
      .mockResolvedValueOnce({ rowCount: 1, rows: [existing] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // COMMIT
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // INSERT conflict
      .mockResolvedValueOnce({ rowCount: 1, rows: [existing] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // ROLLBACK
    const repository = new PostgresGenericMeasurementRepository(poolFor(query));

    await expect(repository.append(input)).resolves.toBe('duplicate');
    await expect(repository.append({ ...input, value: 21 }))
      .rejects.toBeInstanceOf(ConflictingMeasurementSampleError);
  });
});
