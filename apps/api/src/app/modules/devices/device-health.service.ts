import { Injectable } from '@nestjs/common';
import { DeviceObservationService, type DeviceMemory } from './device-observation.service';

export interface DeviceHealthSnapshot {
  deviceId: string;
  status: 'healthy' | 'degraded' | 'stale';
  confidence: number;
  ageSeconds: number | null;
  lastSeen: string;
  reason: string;
}

@Injectable()
export class DeviceHealthService {
  constructor(
    private readonly observation: DeviceObservationService,
  ) {}

  getAll(now: number = Date.now()): DeviceHealthSnapshot[] {
    return this.observation
      .getAll()
      .map((memory) => this.evaluate(memory, now));
  }

  evaluate(memory: DeviceMemory, now: number = Date.now()): DeviceHealthSnapshot {
    const lastSeen = Date.parse(memory.lastSeen);
    if (!Number.isFinite(lastSeen)) {
      return this.unverified(memory, 'Invalid telemetry receive timestamp');
    }
    if (lastSeen > now) {
      return this.unverified(memory, 'Telemetry receive timestamp is in the future');
    }

    const ageSeconds = Math.floor((now - lastSeen) / 1000);

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
      status: 'stale',
      confidence: 0.95,
      ageSeconds,
      lastSeen: memory.lastSeen,
      reason: 'No recent telemetry; device reachability has not been checked',
    };
  }

  private unverified(
    memory: DeviceMemory,
    reason: string,
  ): DeviceHealthSnapshot {
    return {
      deviceId: memory.deviceId,
      status: 'stale',
      confidence: 0.95,
      ageSeconds: null,
      lastSeen: memory.lastSeen,
      reason: `${reason}; device freshness cannot be established`,
    };
  }
}
