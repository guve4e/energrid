import { Injectable } from '@nestjs/common'

export type OperationalLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type OperationalLogSource =
  | 'device-control'
  | 'mqtt-ingest'
  | 'device-registry'
  | 'portal'
  | 'voice'

type MqttStageOutcome<
  Stage extends string,
  Success extends string,
  Reasoned extends string = never,
> =
  | { stage: Stage; outcome: Success; reasonCode?: never }
  | { stage: Stage; outcome: Reasoned; reasonCode: string }

export type MqttProcessingStageEvent = {
  correlationId: string
  topic: string
  deviceId?: string
} & (
  | MqttStageOutcome<'received', 'received'>
  | MqttStageOutcome<'parse', 'parsed', 'failed'>
  | MqttStageOutcome<'routing', 'routed', 'skipped'>
  | MqttStageOutcome<'evidence', 'matched', 'skipped'>
  | MqttStageOutcome<'persistence', 'succeeded', 'failed' | 'skipped'>
  | MqttStageOutcome<'discovery', 'refreshed', 'failed' | 'skipped'>
  | MqttStageOutcome<'observation', 'admitted', 'rejected' | 'skipped'>
  | MqttStageOutcome<'registry', 'updated', 'not_updated'>
)

export interface OperationalLogEntry {
  id: string
  observedAt: string
  level: OperationalLogLevel
  source: OperationalLogSource
  event: string
  message: string
  deviceId?: string
  topic?: string
  status?: string
  details?: Record<string, string | number | boolean | null>
  correlationId?: string
  stage?: MqttProcessingStageEvent['stage']
  outcome?: string
  reasonCode?: string
}

@Injectable()
export class OperationalLogService {
  private readonly entries: OperationalLogEntry[] = []
  private readonly mqttStagesByDevice = new Map<string, OperationalLogEntry[]>()
  private sequence = 0

  recordMqttStage(
    event: MqttProcessingStageEvent,
  ): OperationalLogEntry | null {
    // Broker health chatter is not device processing evidence and can arrive
    // fast enough to evict actionable lifecycle diagnostics.
    if (event.topic.startsWith('$SYS/')) return null;
    const { stage, outcome, reasonCode } = event
    const needsReason = [
      'failed',
      'skipped',
      'rejected',
      'not_updated',
    ].includes(outcome)
    if (needsReason && !reasonCode?.trim()) {
      throw new Error(`MQTT ${outcome} stage requires a reasonCode`)
    }

    return this.record({
      level: needsReason ? 'warn' : 'info',
      source: 'mqtt-ingest',
      event: 'mqtt.processing_stage',
      message: `MQTT ${stage} ${outcome}${reasonCode ? ` (${reasonCode})` : ''}.`,
      topic: event.topic,
      deviceId: event.deviceId,
      correlationId: event.correlationId,
      stage,
      outcome,
      reasonCode,
    })
  }

  record(
    entry: Omit<OperationalLogEntry, 'id' | 'observedAt'> & {
      observedAt?: string
    },
  ): OperationalLogEntry {
    const observedAt = entry.observedAt || new Date().toISOString()
    const next: OperationalLogEntry = {
      ...entry,
      id: `${Date.parse(observedAt)}:${++this.sequence}:${entry.source}:${entry.event}`,
      observedAt,
    }

    if (next.source === 'mqtt-ingest' && next.event === 'mqtt.processing_stage' && next.topic) {
      const key = mqttDiagnosticDeviceKey(next.topic)
      const bucket = this.mqttStagesByDevice.get(key) || []
      bucket.push(next)
      if (bucket.length > 32) bucket.shift()
      this.mqttStagesByDevice.delete(key)
      this.mqttStagesByDevice.set(key, bucket)
      while (this.mqttStagesByDevice.size > 256) {
        const oldestKey = this.mqttStagesByDevice.keys().next().value
        if (oldestKey === undefined) break
        this.mqttStagesByDevice.delete(oldestKey)
      }
      return next
    }

    this.entries.push(next)
    const maxEntries = Number(process.env.HOME_OPERATION_LOG_MAX_ENTRIES || 500)
    if (this.entries.length > maxEntries) {
      this.entries.splice(0, this.entries.length - maxEntries)
    }

    return next
  }

  recent(limit = 200): OperationalLogEntry[] {
    return [...this.entries, ...[...this.mqttStagesByDevice.values()].flat()]
      .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))
      .slice(0, limit)
  }
}

function mqttDiagnosticDeviceKey(topic: string): string {
  const parts = topic.split('/').filter(Boolean)
  if (parts[0] === 'devices' && parts.length > 1) return parts.slice(0, 2).join('/')
  const devicesIndex = parts.indexOf('devices')
  if (devicesIndex >= 0 && parts[devicesIndex + 1]) {
    return parts.slice(0, devicesIndex + 2).join('/')
  }
  return topic
}
