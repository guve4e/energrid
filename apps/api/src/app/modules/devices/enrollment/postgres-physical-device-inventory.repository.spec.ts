import type { Pool } from 'pg';
import { PostgresPhysicalDeviceInventoryRepository } from './postgres-physical-device-inventory.repository';

describe('PostgresPhysicalDeviceInventoryRepository pool usage', () => {
  it('reports whether a broker event was newly inserted for durable replay deduplication', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ event_id: 'new-event' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const repository = new PostgresPhysicalDeviceInventoryRepository({ query } as unknown as Pool);
    const scope = { tenantId: 'tenant-test', siteId: 'site-test' };
    const evidence = {
      eventId: 'new-event', brokerId: 'broker', clientId: 'client', peerIp: '192.168.1.20',
      publishedTopic: 'shelly-test/events/rpc', payloadSha256: 'a'.repeat(64),
      observedAt: '2026-10-20T12:00:00.000Z', connectionState: 'connected' as const,
    };

    await expect(repository.recordMqttPublisherEvidence(scope, evidence)).resolves.toBe(true);
    await expect(repository.recordMqttPublisherEvidence(scope, evidence)).resolves.toBe(false);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT'), expect.any(Array));
  });

  it('reads broker-peer evidence only within the active tenant/site and retention window', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{
      physical_device_id: 'physical-1', shelly_protocol_id: 'shellyplus1-abc',
      broker_id: 'house-broker', client_id: 'client-1', peer_ip: '192.168.1.20',
      observed_at: '2026-10-20T12:00:00.000Z', connection_state: 'connected',
      identity_verification: 'rpc_mismatch',
    }] });
    const pool = { query } as unknown as Pool;
    const repository = new PostgresPhysicalDeviceInventoryRepository(pool);

    const records = await repository.listRecentMqttPublisherEvidence({ tenantId: 'tenant', siteId: 'site' });

    expect(query).toHaveBeenCalledWith(expect.stringContaining("observed_at >= NOW() - INTERVAL '90 days'"), ['tenant', 'site']);
    expect(records).toEqual([expect.objectContaining({
      physicalDeviceId: 'physical-1', peerIp: '192.168.1.20', identityVerification: 'rpc_mismatch',
    })]);
  });

  it('prunes expired broker evidence with scoped, parameterized criteria', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const repository = new PostgresPhysicalDeviceInventoryRepository({ query } as unknown as Pool);
    const cutoff = '2026-07-22T12:00:00.000Z';

    await repository.pruneMqttPublisherEvidence({ tenantId: 'tenant', siteId: 'site' }, cutoff);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('tenant_id=$1 AND site_id=$2 AND observed_at < $3::timestamptz'),
      ['tenant', 'site', cutoff],
    );
  });

  it('releases transaction clients before readback during concurrent MQTT discoveries', async () => {
    let checkedOut = 0;
    const physicalDevices: Array<Record<string, unknown>> = [];
    const pool = {
      connect: jest.fn(async () => {
        if (checkedOut >= 3) throw new Error('test pool exhausted');
        checkedOut += 1;
        return {
          query: jest.fn(async (sql: string, values: unknown[] = []) => {
            if (sql.includes('INSERT INTO device_inventory.physical_devices')) {
              physicalDevices.push({
                tenant_id: values[0],
                site_id: values[1],
                physical_device_id: values[2],
                first_seen_at: values[6],
                last_seen_at: values[6],
                vendor: null,
                hardware_model: null,
                firmware_version: null,
              });
            }
            return { rows: [], rowCount: 1 };
          }),
          release: jest.fn(() => { checkedOut -= 1; }),
        };
      }),
      query: jest.fn(async (sql: string, values: unknown[] = []) => {
        if (checkedOut >= 3) throw new Error('test pool exhausted during readback');
        if (sql.includes('FROM device_inventory.physical_devices')) {
          const row = physicalDevices.find(item =>
            item.tenant_id === values[0] &&
            item.site_id === values[1] &&
            item.physical_device_id === values[2]);
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as Pool;

    const repository = new PostgresPhysicalDeviceInventoryRepository(pool);
    const records = await Promise.all(
      ['boiler', 'oven', 'garage'].map((identity, index) => repository.discover({
        scope: { tenantId: 'tenant-test', siteId: 'site-test' },
        identity: { namespace: 'mqtt:shelly-protocol-id', value: identity },
        evidenceSource: 'mqtt_protocol_message',
        observedAt: `2026-10-19T12:00:0${index}.000Z`,
        components: [{ key: 'em1:0', capabilities: ['power'] }],
      })),
    );

    expect(records).toHaveLength(3);
    expect(new Set(records.map(record => record.physicalDeviceId)).size).toBe(3);
    expect(checkedOut).toBe(0);
  });
});
