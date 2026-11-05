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
  it('creates a minimal enrollment reference with a conflict-safe upsert', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const repository = new PostgresGenericMeasurementRepository({ query } as never);

    await repository.ensureEnrollmentReference({
      tenantId: 'tenant-a', siteId: 'site-a', deviceId: 'device-a',
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining(
      "ON CONFLICT (tenant_id,site_id,device_id) DO NOTHING",
    ), ['tenant-a', 'site-a', 'device-a']);
    expect(query.mock.calls[0][0]).toContain("'History enrollment reference','enrolled',now(),now(),1");
  });

  it('summarizes each metric only from its own authorized sources and exact device scope', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [
      { metric: 'temperature', count: 8, oldest: new Date('2026-10-23T10:00:00.000Z'), newest: new Date('2026-10-24T10:00:00.000Z') },
    ] });
    const repository = new PostgresGenericMeasurementRepository({ query } as never);
    await expect(repository.summarize({
      tenantId: 'tenant-a', siteId: 'site-a', deviceId: 'device-a',
      authorizedSourcesByMetric: {
        temperature: ['source-temperature'],
        humidity: ['source-humidity'],
        not_a_measurement: ['source-other'],
      },
    })).resolves.toEqual([{
      metric: 'temperature', count: 8,
      oldest: '2026-10-23T10:00:00.000Z', newest: '2026-10-24T10:00:00.000Z',
    }]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("component_id='device'"), [
      'tenant-a', 'site-a', 'device-a', 'temperature', ['source-temperature'],
      'humidity', ['source-humidity'],
    ]);
    expect(query.mock.calls[0][0]).toContain('(metric=$4 AND source=ANY($5::text[]))');
    expect(query.mock.calls[0][0]).toContain('(metric=$6 AND source=ANY($7::text[]))');
    expect(query.mock.calls[0][0]).toContain('tenant_id=$1 AND site_id=$2 AND device_id=$3');
  });

  it('does not run an unrestricted summary query when no metric has an approved source', async () => {
    const query = jest.fn();
    const repository = new PostgresGenericMeasurementRepository({ query } as never);

    await expect(repository.summarize({
      tenantId: 'tenant-a', siteId: 'site-a', deviceId: 'device-a',
      authorizedSourcesByMetric: { temperature: [], humidity: ['  '] },
    })).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('reads the latest sample by exact tenant, site, component, channel and metric', async () => {
    const row = {
      schema_version: 1, tenant_id: 'tenant-a', site_id: 'site-a', device_id: 'device-a',
      physical_device_id: null, component_id: 'device', channel: 'power', metric: 'power',
      unit: 'W', value: 42, quality: 'measured', source: 'approved-http-adapter',
      provenance: 'binding-1', sample_id: 'sample-latest',
      observed_at: new Date('2026-10-24T10:00:00.000Z'),
      received_at: new Date('2026-10-24T10:00:01.000Z'),
    };
    const query = jest.fn().mockResolvedValue({ rows: [row] });
    const repository = new PostgresGenericMeasurementRepository({ query } as never);

    await expect(repository.latest({
      tenantId: 'tenant-a', siteId: 'site-a', deviceId: 'device-a',
      componentId: 'device', channel: 'power', metric: 'power',
    })).resolves.toMatchObject({
      deviceId: 'device-a', metric: 'power', value: 42,
      observedAt: '2026-10-24T10:00:00.000Z',
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining(
      'ORDER BY observed_at DESC,received_at DESC,sample_id DESC LIMIT 1',
    ), ['tenant-a', 'site-a', 'device-a', 'device', 'power', 'power']);
  });

  it('restricts history and latest sample to approved observation sources when provided', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repository = new PostgresGenericMeasurementRepository({ query } as never);
    const identity = {
      tenantId: 'tenant-a', siteId: 'site-a', deviceId: 'device-a',
      componentId: 'device', channel: 'power', metric: 'power',
      sources: ['approved-http-adapter'],
    };
    const from = '2026-10-24T09:00:00.000Z';
    const to = '2026-10-24T10:00:00.000Z';

    await repository.latest(identity);
    await repository.read({ ...identity, from, to, limit: 25 });

    expect(query.mock.calls[0][0]).toContain('source=ANY($7::text[])');
    expect(query.mock.calls[0][1]).toEqual([
      'tenant-a', 'site-a', 'device-a', 'device', 'power', 'power', ['approved-http-adapter'],
    ]);
    expect(query.mock.calls[1][0]).toContain('source=ANY($10::text[])');
    expect(query.mock.calls[1][1]).toEqual([
      'tenant-a', 'site-a', 'device-a', 'device', 'power', 'power', from, to, 25,
      ['approved-http-adapter'],
    ]);
  });


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
