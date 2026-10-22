import type { DeviceInstallationRecord } from './device-installation.store';
import {
  resolveDeviceTarget,
  type DeviceTargetRequest,
} from './device-intelligence-target-resolver';

const scope = { tenantId: 'home', siteId: 'house' };

function install(
  id: string,
  options: {
    room?: string;
    loadType?: string;
    assistantEnabled?: boolean;
    tenantId?: string;
    capability?: string;
  } = {},
): DeviceInstallationRecord {
  return {
    schemaVersion: 1,
    device: {
      id,
      displayName: id,
      tenantId: options.tenantId ?? 'home',
      siteId: 'house',
      trustStatus: 'approved',
      zoneName: options.room ?? 'kitchen',
      assistantEnabled: options.assistantEnabled ?? true,
      capabilities: [{ kind: options.capability ?? 'switch' }],
      metadata: options.loadType
        ? { loadType: options.loadType }
        : {},
    },
  } as unknown as DeviceInstallationRecord;
}

function resolve(
  records: DeviceInstallationRecord[],
  request: DeviceTargetRequest,
  ids = records.map(record => record.device.id),
) {
  return resolveDeviceTarget(
    records,
    new Set(ids),
    scope,
    request,
  );
}

describe('Device Intelligence target resolution', () => {
  it('resolves an exact enrolled device ID', () => {
    expect(resolve(
      [install('kitchen-shelly')],
      { kind: 'exact', identifier: 'Kitchen Shelly' },
    )).toEqual({
      status: 'resolved',
      deviceId: 'kitchen-shelly',
    });
  });

  it('requires durable enrollment', () => {
    expect(resolve(
      [install('kitchen-shelly')],
      { kind: 'exact', identifier: 'kitchen-shelly' },
      [],
    )).toEqual({ status: 'not_found' });
  });

  it('enforces tenant isolation', () => {
    expect(resolve(
      [install('kitchen-shelly', { tenantId: 'other' })],
      { kind: 'exact', identifier: 'kitchen-shelly' },
    )).toEqual({ status: 'not_found' });
  });

  it('does not assume a kitchen switch controls lighting', () => {
    expect(resolve(
      [install('kitchen-shelly')],
      { kind: 'room-load', room: 'kitchen', loadType: 'lighting' },
    )).toEqual({ status: 'not_found' });
  });

  it('resolves approved kitchen lighting metadata', () => {
    expect(resolve(
      [install('light-1', { loadType: 'lighting' })],
      { kind: 'room-load', room: 'kitchen', loadType: 'lighting' },
    )).toEqual({
      status: 'resolved',
      deviceId: 'light-1',
    });
  });

  it('rejects ambiguity instead of guessing', () => {
    expect(resolve(
      [
        install('light-1', { loadType: 'lighting' }),
        install('light-2', { loadType: 'lighting' }),
      ],
      { kind: 'room-load', room: 'kitchen', loadType: 'lighting' },
    )).toEqual({
      status: 'ambiguous',
      deviceIds: ['light-1', 'light-2'],
    });
  });

  it('blocks assistant-disabled devices', () => {
    expect(resolve(
      [install('light-1', {
        loadType: 'lighting',
        assistantEnabled: false,
      })],
      { kind: 'room-load', room: 'kitchen', loadType: 'lighting' },
    )).toEqual({
      status: 'blocked',
      deviceId: 'light-1',
      reason: 'assistant_disabled',
    });
  });

  it('requires a controllable capability', () => {
    expect(resolve(
      [install('sensor-1', {
        loadType: 'lighting',
        capability: 'temperature',
      })],
      { kind: 'room-load', room: 'kitchen', loadType: 'lighting' },
    )).toEqual({
      status: 'blocked',
      deviceId: 'sensor-1',
      reason: 'capability_missing',
    });
  });
});
