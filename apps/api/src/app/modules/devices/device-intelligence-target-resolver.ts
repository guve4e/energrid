import type { DeviceInstallationRecord } from './device-installation.store';

export interface DeviceTargetScope {
  tenantId: string;
  siteId: string;
}

export type DeviceTargetRequest =
  | { kind: 'exact'; identifier: string }
  | { kind: 'room-load'; room: string; loadType: 'lighting' };

export type DeviceTargetResolution =
  | { status: 'resolved'; deviceId: string }
  | { status: 'not_found' }
  | { status: 'ambiguous'; deviceIds: string[] }
  | {
      status: 'blocked';
      deviceId: string;
      reason: 'assistant_disabled' | 'capability_missing';
    };

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Resolve only within trusted, approved installation records.
 *
 * enrolledIds must come from the durable enrollment inventory,
 * never from discovery candidates or a device payload.
 *
 * Resolution is not authorization to execute a command.
 */
export function resolveDeviceTarget(
  installations: readonly DeviceInstallationRecord[],
  enrolledIds: ReadonlySet<string>,
  scope: DeviceTargetScope,
  request: DeviceTargetRequest,
): DeviceTargetResolution {
  const candidates = installations
    .map(record => record.device)
    .filter(device =>
      device.tenantId === scope.tenantId &&
      device.siteId === scope.siteId &&
      device.trustStatus === 'approved' &&
      enrolledIds.has(device.id)
    );

  const matches = candidates.filter(device => {
    if (request.kind === 'exact') {
      const name = normalize(request.identifier);
      return !!name && (
        normalize(device.id) === name ||
        normalize(device.displayName) === name
      );
    }

    const room = normalize(request.room);
    return !!room &&
      normalize(device.zoneName) === room &&
      device.metadata?.['loadType'] === request.loadType;
  });

  if (matches.length === 0) {
    return { status: 'not_found' };
  }

  // Never choose one candidate merely because it has
  // more permissions than another candidate.
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      deviceIds: matches.map(device => device.id).sort(),
    };
  }

  const device = matches[0];

  if (!device.assistantEnabled) {
    return {
      status: 'blocked',
      deviceId: device.id,
      reason: 'assistant_disabled',
    };
  }

  if (!device.capabilities.some(capability =>
    capability.kind === 'switch' ||
    capability.kind === 'light'
  )) {
    return {
      status: 'blocked',
      deviceId: device.id,
      reason: 'capability_missing',
    };
  }

  return {
    status: 'resolved',
    deviceId: device.id,
  };
}
