import { Injectable } from '@nestjs/common';
import type {
  NetworkDiscoveredDevice,
  RegisteredDevice,
} from './device-registry.types';

export interface DeviceMatchCandidate {
  deviceId: string;
  registeredDeviceId?: string;
  confidence: number;
  reason: string;
}

@Injectable()
export class DeviceMatchService {

  match(
    network: NetworkDiscoveredDevice,
    registered: RegisteredDevice[],
  ): DeviceMatchCandidate | null {

    const shellyCandidates = registered.filter(
      (device) =>
        device.adapter.driver.includes('shelly') ||
        device.metadata?.origin === 'shelly',
    );

    if (
      network.vendor === 'Shelly' &&
      shellyCandidates.length === 0
    ) {
      return {
        deviceId: network.id,
        confidence: 0.8,
        reason:
          'Shelly device discovered but no Shelly profile exists',
      };
    }

    return null;
  }
}
