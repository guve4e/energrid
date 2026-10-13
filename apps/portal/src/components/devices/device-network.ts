import type { ControlSetupDevice } from './device-control';

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
