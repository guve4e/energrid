import {
  DeviceEvidence,
  DeviceEvidenceSnapshot,
  EvidenceSource,
  evidenceId,
} from './device-evidence'

type EvidenceValue = string | number | boolean

export interface NetworkEvidenceInput {
  id: string
  ipAddress?: string
  hostname?: string
  macAddress?: string
  vendor?: string
  model?: string
  protocol?: string
  app?: string
  status?: string
  observations?: Array<{
    source?: string
    attribute?: string
    value?: unknown
  }>
}

const allowedAttributes: Array<
  keyof Omit<NetworkEvidenceInput, 'id'>
> = [
  'ipAddress',
  'hostname',
  'macAddress',
  'vendor',
  'model',
  'protocol',
  'app',
  'status',
]

export function buildNetworkEvidenceSnapshot(
  device: NetworkEvidenceInput,
  observedAt = new Date().toISOString(),
): DeviceEvidenceSnapshot {
  if (!device.id || device.id.length > 160) {
    throw new Error('Invalid device identifier')
  }

  if (Number.isNaN(Date.parse(observedAt))) {
    throw new Error('Invalid observation timestamp')
  }

  const evidence: DeviceEvidence[] = []

  function add(
    source: EvidenceSource,
    attribute: string,
    value: EvidenceValue,
  ): void {
    const safeValue =
      typeof value === 'string'
        ? value.slice(0, 160)
        : value

    evidence.push({
      id: evidenceId(device.id, source, attribute, safeValue),
      source,
      attribute,
      value: safeValue,
      observedAt,
      confidence: 'reported',
    })
  }

  for (const attribute of allowedAttributes) {
    const value = device[attribute]

    if (typeof value !== 'string' || !value.trim()) {
      continue
    }

    add('network_scan', attribute, value)
  }

  // Preserve structured scanner observations, but only for
  // explicitly supported sources and attributes.
  const allowedObservationSources = new Set([
    'network_scan',
    'mdns',
    'ssdp',
    'http',
  ])

  const allowedObservationAttributes = new Set([
    'reachable',
    'hostname',
    'service',
    'service_name',
    'service_port',
    'protocol',
  ])

  const allowedPortObservation = /^port\.(\d{1,5})\.open$/

  for (const observation of device.observations?.slice(0, 64) || []) {
    if (
      !observation ||
      typeof observation !== 'object' ||
      typeof observation.source !== 'string' ||
      typeof observation.attribute !== 'string'
    ) {
      continue
    }

    const source =
      observation.source === 'tcp'
        ? 'network_scan'
        : observation.source

    if (!allowedObservationSources.has(source)) {
      continue
    }

    const portMatch =
      observation.attribute.match(allowedPortObservation)

    if (portMatch) {
      const port = Number(portMatch[1])

      if (port < 1 || port > 65535) {
        continue
      }
    } else if (
      !allowedObservationAttributes.has(observation.attribute)
    ) {
      continue
    }

    const value = observation.value

    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      continue
    }

    if (
      typeof value === 'number' &&
      !Number.isFinite(value)
    ) {
      continue
    }

    add(
      source as EvidenceSource,
      observation.attribute,
      value,
    )
  }

  return {
    schemaVersion: 1,
    deviceId: device.id,
    createdAt: observedAt,
    evidence,
  }
}
