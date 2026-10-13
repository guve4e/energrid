import type { ElectricalReading } from '@energrid/domain-telemetry';
import type { RegisteredDevice } from '../devices/device-registry.types';

export const testReading = (
  patch: Partial<ElectricalReading> = {},
): ElectricalReading => ({
  schemaVersion: 1,
  tenantId: 'tenant-demo',
  siteId: 'site-home',
  deviceId: 'meter',
  channel: 'em1:0',
  metric: 'power',
  value: 3000,
  unit: 'W',
  quality: 'measured',
  observedAt: '2026-10-11T01:00:00.000Z',
  receivedAt: '2026-10-11T01:00:01.000Z',
  timestampBasis: 'device-observed',
  source: 'shelly',
  ...patch,
});

export const testDevice = () =>
  ({
    id: 'meter',
    tenantId: 'tenant-demo',
    siteId: 'site-home',
    kind: 'physical',
    trustStatus: 'approved',
    capabilities: [{ kind: 'power', unit: 'W', actions: ['read'] }],
  }) as RegisteredDevice;

export const testStoredRow = (patch: Record<string, unknown> = {}) => ({
  schema_version: 1,
  tenant_id: 'tenant-demo',
  site_id: 'site-home',
  device_id: 'meter',
  channel: 'em1:0',
  metric: 'power',
  value: 3000,
  unit: 'W',
  quality: 'measured',
  observed_at: new Date('2026-10-11T01:00:00.000Z'),
  received_at: new Date('2026-10-11T01:00:01.000Z'),
  timestamp_basis: 'device-observed',
  source: 'shelly',
  ...patch,
});
import { TelemetrySpool, type SpoolDatabase } from './telemetry-spool';
import { telemetryConfig } from './telemetry.config';

/** Mock disk operations, keeping the real outbox/replay policies under unit test. */
export function testSpool(
  maxPendingWrites = 100_000,
  enabled = true,
  data = new Map<string, unknown>(),
) {
  const db = {
    open: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    get: jest.fn(async (key: string) => structuredClone(data.get(key))),
    batch: jest.fn(
      async (ops: { type: string; key: string; value?: unknown }[]) => {
        for (const op of ops) {
          if (op.type === 'del') data.delete(op.key);
          else data.set(op.key, structuredClone(op.value));
        }
      },
    ),
    iterator: jest.fn(
      (options: { gte?: string; lt?: string; limit?: number } = {}) => {
        const rows = [...data]
          .sort(([a], [b]) => a.localeCompare(b))
          .filter(
            ([key]) =>
              (!options.gte || key >= options.gte) &&
              (!options.lt || key < options.lt),
          );
        return {
          all: jest
            .fn()
            .mockResolvedValue(rows.slice(0, options.limit ?? rows.length)),
        };
      },
    ),
  };
  const config = {
    ...telemetryConfig({}),
    enabled,
    spoolDirectory: '/private/tmp/mock-unit-spool',
    maxPendingWrites,
  };
  const factory = jest.fn(() => db as unknown as SpoolDatabase);
  return {
    spool: new TelemetrySpool(config, factory),
    db,
    data,
    factory,
    config,
  };
}
