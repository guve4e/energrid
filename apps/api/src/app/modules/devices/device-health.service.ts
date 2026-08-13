import { Injectable } from '@nestjs/common';
import { DeviceObservationService, type DeviceMemory } from './device-observation.service';

export interface DeviceHealthSnapshot {
  deviceId: string;
  status: 'healthy' | 'degraded' | 'unreachable';
  confidence: number;
  ageSeconds: number;
  lastSeen: string;
  reason: string;
}

@Injectable()
export class DeviceHealthService {
  constructor(
    private readonly observation: DeviceObservationService,
  ) {}

  getAll(): DeviceHealthSnapshot[] {
    return this.observation
      .getAll()
      .map((memory) => this.evaluate(memory));
  }

  evaluate(memory: DeviceMemory): DeviceHealthSnapshot {
    const now = Date.now();
    const lastSeen = new Date(memory.lastSeen).getTime();

    const ageSeconds = Math.max(
      0,
      Math.floor((now - lastSeen) / 1000),
    );

    if (ageSeconds <= 30) {
      return {
        deviceId: memory.deviceId,
        status: 'healthy',
        confidence: 0.99,
        ageSeconds,
        lastSeen: memory.lastSeen,
        reason: 'Telemetry received recently',
      };
    }

    if (ageSeconds <= 300) {
      return {
        deviceId: memory.deviceId,
        status: 'degraded',
        confidence: 0.7,
        ageSeconds,
        lastSeen: memory.lastSeen,
        reason: 'Telemetry delayed',
      };
    }

    return {
      deviceId: memory.deviceId,
      status: 'unreachable',
      confidence: 0.95,
      ageSeconds,
        lastSeen: memory.lastSeen,
      reason: 'No recent telemetry',
    };
  }
}
