import { Injectable } from '@nestjs/common'

export interface DeviceObservation {
  deviceId: string
  observedAt: string
  source: string
  values: Record<string, unknown>
}

export interface DeviceMemory {
  deviceId: string
  firstSeen: string
  lastSeen: string
  observations: number
  lastValues: Record<string, unknown>
  source: string
}

@Injectable()
export class DeviceObservationService {
  private readonly memory = new Map<string, DeviceMemory>()

  observe(observation: DeviceObservation): void {
    const existing = this.memory.get(observation.deviceId)

    this.memory.set(observation.deviceId, {
      deviceId: observation.deviceId,
      firstSeen: existing?.firstSeen || observation.observedAt,
      lastSeen: observation.observedAt,
      observations: (existing?.observations || 0) + 1,
      lastValues: observation.values,
      source: observation.source,
    })
  }

  getDevice(deviceId: string): DeviceMemory | null {
    return this.memory.get(deviceId) || null
  }

  getAll(): DeviceMemory[] {
    return [...this.memory.values()]
  }
}
