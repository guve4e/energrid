import type { ControlSetupDevice } from './device-control';
import { privateShellyBaseUrl } from '@energrid/domain-devices';

export interface NetworkIdentity {
  id: string;
  ipAddress: string;
  hostname?: string;
  macAddress?: string;
}

function mac(value: string): string | null {
  const parts = value.split(':');
  if (parts.length === 6 && parts.every((p) => /^[0-9a-f]{1,2}$/i.test(p)))
    return parts
      .map((p) => p.padStart(2, '0'))
      .join('')
      .toLowerCase();
  return /(?:^|-)([0-9a-f]{12})$/i.exec(value)?.[1].toLowerCase() || null;
}

export function matchNetworkDevice<T extends NetworkIdentity>(
  device: ControlSetupDevice,
  network: T[],
): T | null {
  const values = [
    device.metadata?.physicalId,
    device.metadata?.hardwareId,
    device.metadata?.dst,
    device.adapter.target,
    device.id,
  ]
    .filter((v): v is string => typeof v === 'string' && !!v)
    .map((v) =>
      v
        .toLowerCase()
        .trim()
        .replace(/:(switch|em1):\d+$/, ''),
    );
  return (
    network.find((candidate) =>
      values.some((value) => {
        if (
          [candidate.id, candidate.hostname, candidate.ipAddress].some(
            (v) => v?.toLowerCase() === value,
          )
        )
          return true;
        const hardwareMac = mac(value);
        return (
          !!hardwareMac &&
          [candidate.id, candidate.macAddress].some(
            (v) => !!v && mac(v) === hardwareMac,
          )
        );
      }),
    ) || null
  );
}

/**
 * Presentation-only enrollment identity match.
 *
 * Requires a complete MAC address on both sides.
 * Does not use IP addresses, hostnames, MQTT topics or model names.
 * Never grants enrollment, observation authority or control permissions.
 */
export function hasVerifiedEnrolledNetworkIdentity(
  networkDevice: NetworkIdentity,
  enrolledDevices: readonly ControlSetupDevice[],
): boolean {
  const networkMac = networkDevice.macAddress
    ? mac(networkDevice.macAddress)
    : null;

  if (!networkMac) return false;

  return enrolledDevices.some(device => {
    const identities = [
      device.metadata?.physicalId,
      device.metadata?.hardwareId,
      device.metadata?.dst,
      device.id,
    ];

    return identities.some(value => {
      if (typeof value !== 'string') return false;

      const physicalIdentity = value.replace(
        /:(switch|em1):\\d+$/i,
        '',
      );

      return mac(physicalIdentity) === networkMac;
    });
  });
}

export function discoveredShellyAddress(
  device: ControlSetupDevice,
  network: NetworkIdentity[],
): string | null {
  if (!device.adapter.driver.includes('shelly')) return null;
  const physicalId = device.metadata?.physicalId;
  if (typeof physicalId !== 'string' || !physicalId) return null;
  const hardwareMac = mac(physicalId);
  const matches = network.filter(
    (candidate) =>
      candidate.id.toLowerCase() === physicalId.toLowerCase() ||
      (!!hardwareMac &&
        [candidate.id, candidate.macAddress].some(
          (value) => !!value && mac(value) === hardwareMac,
        )),
  );
  const origins = new Set(
    matches
      .map((candidate) => localOrigin(`http://${candidate.ipAddress}`))
      .filter((origin): origin is string => !!origin),
  );
  if (origins.size > 1) return null;
  if (origins.size === 1) return [...origins][0];
  const metadata = localOrigin(device.metadata?.httpBaseUrl);
  if (metadata) return metadata;
  if (device.adapter.protocol === 'http' && device.adapter.target) {
    try {
      const target = new URL(device.adapter.target);
      if (!target.username && !target.password)
        return localOrigin(target.origin);
    } catch {
      return null;
    }
  }
  return null;
}

function localOrigin(value: unknown): string | null {
  try {
    return privateShellyBaseUrl(value);
  } catch {
    return null;
  }
}
