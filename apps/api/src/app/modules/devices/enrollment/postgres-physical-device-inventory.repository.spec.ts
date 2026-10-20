import type { Pool } from 'pg';
import { PostgresPhysicalDeviceInventoryRepository } from './postgres-physical-device-inventory.repository';

describe('PostgresPhysicalDeviceInventoryRepository pool usage', () => {
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
