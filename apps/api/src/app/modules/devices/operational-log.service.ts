import { Injectable } from '@nestjs/common'

export type OperationalLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type OperationalLogSource =
  | 'device-control'
  | 'mqtt-ingest'
  | 'device-registry'
  | 'portal'
  | 'voice'

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
}

@Injectable()
export class OperationalLogService {
  private readonly entries: OperationalLogEntry[] = []

  record(
    entry: Omit<OperationalLogEntry, 'id' | 'observedAt'> & {
      observedAt?: string
    },
  ): OperationalLogEntry {
    const observedAt = entry.observedAt || new Date().toISOString()
    const next: OperationalLogEntry = {
      ...entry,
      id: `${Date.parse(observedAt)}:${this.entries.length}:${entry.source}:${entry.event}`,
      observedAt,
    }

    this.entries.push(next)
    const maxEntries = Number(process.env.HOME_OPERATION_LOG_MAX_ENTRIES || 500)
    if (this.entries.length > maxEntries) {
      this.entries.splice(0, this.entries.length - maxEntries)
    }

    return next
  }

  recent(limit = 200): OperationalLogEntry[] {
    return [...this.entries]
      .reverse()
      .slice(0, limit)
  }
}
