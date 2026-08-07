const DEFAULT_BEHAVIOR = Object.freeze({
  delayMs: 250,
  dropAcknowledgement: false,
  rejectCommand: false,
  reportOppositeState: false,
  staleTelemetry: false,
  partialObservation: false,
  malformedPayload: false,
  packetLossPercent: 0,
  driftAfterMs: 0,
  unstableForMs: 0,
  settleForMs: 500,
})

class SimulatedDevice {
  constructor(definition, runtimeProfile = {}) {
    validateDefinition(definition)

    this.id = definition.id
    this.name = definition.name
    this.deviceType = definition.deviceType
    this.protocol = definition.protocol
    this.transport = definition.transport || definition.protocol
    this.driver = definition.driver
    this.bridge = definition.bridge
    this.zone = definition.zone || 'Unassigned'
    this.capabilities = structuredClone(definition.capabilities || [])
    this.protocolConfig = structuredClone(definition.protocolConfig || {})

    this.values = structuredClone(definition.initialValues || {})
    this.online = runtimeProfile.online ?? true
    this.sequence = 0

    this.behavior = {
      ...DEFAULT_BEHAVIOR,
      ...(runtimeProfile.behavior || {}),
    }

    this.lastCommand = null
    this.lastObservation = null
    this.lastEvidence = null
  }

  supportsAction(action) {
    return this.capabilities.some((capability) =>
      capability.actions?.includes(action),
    )
  }

  isControllable() {
    return this.capabilities.some((capability) =>
      capability.actions?.some((action) => action !== 'read'),
    )
  }

  patchBehavior(patch) {
    this.behavior = {
      ...this.behavior,
      ...normalizeBehaviorPatch(patch),
    }

    return this.behavior
  }

  patchValues(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return this.values
    }

    for (const [key, value] of Object.entries(patch)) {
      if (isPrimitive(value)) {
        this.values[key] = value
      }
    }

    return this.values
  }

  setOnline(online) {
    this.online = Boolean(online)
  }

  beginCommand(action, expectedValues) {
    const requestedAt = new Date().toISOString()
    const id = `${this.id}:${Date.now()}:${++this.sequence}`

    this.lastCommand = {
      id,
      action,
      expectedValues: structuredClone(expectedValues),
      requestedAt,
      stage: 'accepted',
      stages: [
        {
          stage: 'accepted',
          observedAt: requestedAt,
          reason: 'Device Lab accepted the command request.',
        },
      ],
    }

    return this.lastCommand
  }

  transitionCommand(stage, reason, details = {}) {
    if (!this.lastCommand) return null

    const observedAt = new Date().toISOString()

    this.lastCommand = {
      ...this.lastCommand,
      ...details,
      stage,
      stages: [
        ...(this.lastCommand.stages || []),
        {
          stage,
          observedAt,
          reason,
        },
      ],
    }

    return this.lastCommand
  }

  recordObservation(observation) {
    this.lastObservation = structuredClone(observation)
    return this.lastObservation
  }

  recordEvidence(evidence) {
    this.lastEvidence = structuredClone(evidence)
    return this.lastEvidence
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      deviceType: this.deviceType,
      protocol: this.protocol,
      transport: this.transport,
      driver: this.driver,
      bridge: this.bridge,
      zone: this.zone,
      capabilities: structuredClone(this.capabilities),
      protocolConfig: structuredClone(this.protocolConfig),
      values: structuredClone(this.values),
      online: this.online,
      behavior: structuredClone(this.behavior),
      lastCommand: structuredClone(this.lastCommand),
      lastObservation: structuredClone(this.lastObservation),
      lastEvidence: structuredClone(this.lastEvidence),
    }
  }

  runtimeProfile() {
    return {
      online: this.online,
      behavior: structuredClone(this.behavior),
    }
  }
}

function validateDefinition(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new Error('Device definition must be an object.')
  }

  for (const field of [
    'id',
    'name',
    'deviceType',
    'protocol',
    'driver',
  ]) {
    if (!String(definition[field] || '').trim()) {
      throw new Error(`Device definition is missing ${field}.`)
    }
  }

  if (!Array.isArray(definition.capabilities)) {
    throw new Error(`Device ${definition.id} capabilities must be an array.`)
  }
}

function normalizeBehaviorPatch(input) {
  const next = {}

  for (const key of [
    'delayMs',
    'driftAfterMs',
    'unstableForMs',
    'settleForMs',
    'packetLossPercent',
  ]) {
    if (Number.isFinite(Number(input?.[key]))) {
      const value = Math.max(0, Number(input[key]))

      next[key] =
        key === 'packetLossPercent'
          ? Math.min(100, value)
          : value
    }
  }

  for (const key of [
    'dropAcknowledgement',
    'rejectCommand',
    'reportOppositeState',
    'staleTelemetry',
    'partialObservation',
    'malformedPayload',
  ]) {
    if (typeof input?.[key] === 'boolean') {
      next[key] = input[key]
    }
  }

  return next
}

function isPrimitive(value) {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

module.exports = {
  DEFAULT_BEHAVIOR,
  SimulatedDevice,
  normalizeBehaviorPatch,
}
