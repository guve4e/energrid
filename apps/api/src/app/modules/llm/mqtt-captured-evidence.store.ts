import { createHash, randomUUID } from 'node:crypto'
import { Logger } from '@nestjs/common'
import { ClassicLevel } from 'classic-level'

import type { DeviceEvidenceSnapshot } from './device-evidence'
import type { CapturedMqttSample } from './observation-profile-proposal'

export interface MqttCaptureScope {
  tenantId: string
  siteId: string
}

export interface MqttCaptureInput {
  scope: MqttCaptureScope
  deviceId: string
  topic: string
  payloadText: string
}

interface StoredCapture {
  schemaVersion: 1
  id: string
  tenantId: string
  siteId: string
  deviceId: string
  topic: string
  payloadText: string
  contentSha256: string
  receivedAt: string
}

const MAX_PAYLOAD_BYTES = 2048
const MAX_CAPTURES_PER_DEVICE = 32
const MAX_INVESTIGATION_SAMPLES = 8

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 160
}

function segment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function prefix(
  scope: MqttCaptureScope,
  deviceId: string,
): string {
  return [
    'mqtt-capture',
    segment(scope.tenantId),
    segment(scope.siteId),
    segment(deviceId),
    '',
  ].join('/')
}

function fingerprint(topic: string, payloadText: string): string {
  return createHash('sha256')
    .update(topic)
    .update('\0')
    .update(payloadText)
    .digest('hex')
}

function parseSafePayload(payloadText: string): Record<string, unknown> {
  if (
    typeof payloadText !== 'string' ||
    Buffer.byteLength(payloadText, 'utf8') > MAX_PAYLOAD_BYTES
  ) {
    throw new Error('MQTT evidence payload exceeds size limit')
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(payloadText)
  } catch {
    throw new Error('MQTT evidence requires JSON')
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    throw new Error('MQTT evidence requires a JSON object')
  }

  const values = parsed as Record<string, unknown>
  const entries = Object.entries(values)

  if (entries.length === 0 || entries.length > 16) {
    throw new Error('Invalid MQTT evidence field count')
  }

  for (const [key, value] of entries) {
    if (
      !key ||
      key.length > 100 ||
      ['__proto__', 'constructor', 'prototype'].includes(key) ||
      /password|passwd|token|secret|api.?key|authorization/i.test(key)
    ) {
      throw new Error('Unsupported or sensitive MQTT evidence field')
    }

    if (
      !(
        typeof value === 'string' && value.length <= 256 ||
        typeof value === 'boolean' ||
        typeof value === 'number' && Number.isFinite(value)
      )
    ) {
      throw new Error('Only bounded primitive MQTT fields are supported')
    }
  }

  return values
}

/**
 * Stores bounded MQTT evidence captured by the Energrid server.
 *
 * This class deliberately does not subscribe to MQTT or expose
 * a public write endpoint.
 */
export class MqttCapturedEvidenceStore {
  private readonly logger = new Logger(MqttCapturedEvidenceStore.name)
  private readonly db: ClassicLevel<string, StoredCapture>

  constructor(directory: string) {
    if (!directory?.trim()) {
      throw new Error('MQTT evidence storage directory required')
    }

    this.db = new ClassicLevel<string, StoredCapture>(
      directory,
      { valueEncoding: 'json' },
    )
  }

  async capture(input: MqttCaptureInput): Promise<string> {
    if (
      !validIdentifier(input.scope?.tenantId) ||
      !validIdentifier(input.scope?.siteId) ||
      !validIdentifier(input.deviceId) ||
      typeof input.topic !== 'string' ||
      !input.topic ||
      input.topic.length > 512 ||
      /[+#\0]/.test(input.topic)
    ) {
      throw new Error('Invalid MQTT evidence identity or topic')
    }

    parseSafePayload(input.payloadText)

    const receivedAt = new Date().toISOString()
    const nonce = randomUUID()

    const id = `ev_${createHash('sha256')
      .update(JSON.stringify([
        input.scope,
        input.deviceId,
        input.topic,
        receivedAt,
        nonce,
      ]))
      .digest('hex')
      .slice(0, 20)}`

    const record: StoredCapture = {
      schemaVersion: 1,
      id,
      tenantId: input.scope.tenantId,
      siteId: input.scope.siteId,
      deviceId: input.deviceId,
      topic: input.topic,
      payloadText: input.payloadText,
      contentSha256: fingerprint(input.topic, input.payloadText),
      receivedAt,
    }

    const collection = prefix(input.scope, input.deviceId)

    const key = `${collection}${receivedAt}/${nonce}`

    const isBoilerRoomTopic =
      input.topic === 'devices/temp-boiler-room/data'
    if (isBoilerRoomTopic) {
      this.logger.log(
        '[MQTT EVIDENCE DIAG] store_put_started topic=devices/temp-boiler-room/data',
      )
    }

    try {
      await this.db.put(key, record)
    } catch (error) {
      if (isBoilerRoomTopic) {
        const errorName =
          error instanceof Error ? error.name : 'UnknownError'
        this.logger.error(
          `[MQTT EVIDENCE DIAG] store_put_failed topic=devices/temp-boiler-room/data error=${errorName}`,
        )
      }
      throw error
    }

    if (isBoilerRoomTopic) {
      this.logger.log(
        '[MQTT EVIDENCE DIAG] store_put_succeeded topic=devices/temp-boiler-room/data',
      )
    }

    // Keep the local evidence collection bounded.
    const entries = await this.db.iterator({
      gte: collection,
      lt: `${collection}\uffff`,
      reverse: true,
    }).all()

    const expired = entries.slice(MAX_CAPTURES_PER_DEVICE)

    if (expired.length) {
      await this.db.batch(
        expired.map(([expiredKey]) => ({
          type: 'del' as const,
          key: expiredKey,
        })),
      )
    }

    return id
  }

  async readInvestigationEvidence(
    scope: MqttCaptureScope,
    deviceId: string,
    limit = MAX_INVESTIGATION_SAMPLES,
  ): Promise<{
    snapshot: DeviceEvidenceSnapshot
    samples: CapturedMqttSample[]
  }> {
    if (
      !validIdentifier(scope?.tenantId) ||
      !validIdentifier(scope?.siteId) ||
      !validIdentifier(deviceId)
    ) {
      throw new Error('Invalid MQTT evidence lookup')
    }

    const collection = prefix(scope, deviceId)

    const entries = await this.db.iterator({
      gte: collection,
      lt: `${collection}\uffff`,
      reverse: true,
      limit: Math.min(
        Math.max(Math.trunc(limit) || 1, 1),
        MAX_INVESTIGATION_SAMPLES,
      ),
    }).all()

    const records = entries.map(([, record]) => {
      if (
        record.schemaVersion !== 1 ||
        record.tenantId !== scope.tenantId ||
        record.siteId !== scope.siteId ||
        record.deviceId !== deviceId ||
        record.contentSha256 !== fingerprint(
          record.topic,
          record.payloadText,
        )
      ) {
        throw new Error('MQTT evidence integrity check failed')
      }

      parseSafePayload(record.payloadText)

      return record
    })

    const snapshot: DeviceEvidenceSnapshot = {
      schemaVersion: 1,
      deviceId,
      createdAt: new Date().toISOString(),
      evidence: records.map((record) => ({
        id: record.id,
        source: 'mqtt',
        attribute: 'captured-message',
        value: record.topic,
        observedAt: record.receivedAt,
        confidence: 'observed',
      })),
    }

    const samples: CapturedMqttSample[] = records.map((record) => ({
      evidenceId: record.id,
      topic: record.topic,
      payload: parseSafePayload(record.payloadText),
    }))

    return { snapshot, samples }
  }

  async close(): Promise<void> {
    await this.db.close()
  }
}
