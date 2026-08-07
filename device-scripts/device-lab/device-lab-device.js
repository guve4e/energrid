const DEFAULT_BEHAVIOR = {
  delayMs: 250,
  dropAcknowledgement: false,
  rejectCommand: false,
  reportOppositeState: false,
  staleTelemetry: false,
  driftAfterMs: 0,
  unstableForMs: 0,
}

const DEFAULT_TELEMETRY = {
  enabled: true,
  intervalMs: 5000,
  initialDelayMs: 500,
  sequence: 0,
  status: 'idle',
  lastStartedAt: null,
  lastStoppedAt: null,
  lastEmissionAt: null,
  nextEmissionAt: null,
  lastError: null,
  variation: {},
}

function createRuntimeDevice(config) {
  return {
    id: config.id,
    name: config.name,
    protocol: config.protocol,
    transport: config.transport || config.protocol,
    driver: config.driver,
    bridge: config.bridge,
    zone: config.zone || 'Lab',
    capabilities: structuredClone(config.capabilities || []),
    protocolConfig: structuredClone(config.protocolConfig || {}),
    values: structuredClone(config.initialValues || {}),
    online: config.online !== false,
    sequence: 0,
    behavior: {
      ...DEFAULT_BEHAVIOR,
      ...(config.behavior || {}),
    },
    telemetry: {
      ...DEFAULT_TELEMETRY,
      ...(config.telemetry || {}),
      variation: {
        ...DEFAULT_TELEMETRY.variation,
        ...(config.telemetry?.variation || {}),
      },
    },
    lastCommand: null,
    lastObservation: null,
    activity: [],
  }
}

function deviceSupportsAction(device, action) {
  return device.capabilities.some((capability) =>
    capability.actions.includes(action),
  )
}

function commandExpectedValues(device, command) {
  switch (command.action) {
    case 'turn_on':
      return { on: true }

    case 'turn_off':
      return { on: false }

    case 'open':
      return { open: true }

    case 'close':
      return { open: false }

    case 'set_level': {
      const level = clampNumber(command.level, 0, 100)

      return {
        level,
        on: level > 0,
      }
    }

    default:
      return {}
  }
}

function applyExpectedValues(device, expectedValues) {
  Object.assign(device.values, expectedValues)

  if ('on' in expectedValues && 'power' in device.values) {
    device.values.power = expectedValues.on ? inferredOnPower(device) : 0
  }

  if ('open' in expectedValues && 'flow' in device.values) {
    device.values.flow = expectedValues.open ? 7.5 : 0
  }

  if ('level' in expectedValues && 'power' in device.values) {
    device.values.power = Number(
      ((Number(expectedValues.level) / 100) * 18).toFixed(1),
    )
  }
}

function oppositeExpectedValues(expectedValues) {
  const opposite = { ...expectedValues }

  if (typeof opposite.on === 'boolean') opposite.on = !opposite.on
  if (typeof opposite.open === 'boolean') opposite.open = !opposite.open

  if (typeof opposite.level === 'number') {
    opposite.level = opposite.level > 0 ? 0 : 100
    opposite.on = opposite.level > 0
  }

  return opposite
}

function mutateTelemetryValues(device) {
  const variation = device.telemetry?.variation || {}

  for (const [key, configuredDelta] of Object.entries(variation)) {
    const current = Number(device.values[key])
    const delta = Number(configuredDelta)

    if (!Number.isFinite(current) || !Number.isFinite(delta) || delta <= 0) {
      continue
    }

    const randomDelta = (Math.random() * 2 - 1) * delta
    device.values[key] = roundTelemetryValue(current + randomDelta)
  }

  if (
    typeof device.values.battery === 'number' &&
    device.telemetry.sequence > 0 &&
    device.telemetry.sequence % 30 === 0
  ) {
    device.values.battery = Math.max(
      0,
      Number((device.values.battery - 0.1).toFixed(1)),
    )
  }

  if (
    typeof device.values.energy === 'number' &&
    typeof device.values.power === 'number'
  ) {
    const hours = Math.max(1, device.telemetry.intervalMs) / 3_600_000
    const incrementKwh = (device.values.power * hours) / 1000

    device.values.energy = Number(
      (device.values.energy + incrementKwh).toFixed(4),
    )
  }
}

function roundTelemetryValue(value) {
  return Number(value.toFixed(2))
}

function inferredOnPower(device) {
  if (device.capabilities.some((capability) => capability.kind === 'light')) {
    return 18
  }

  return 12.5
}

function clampNumber(value, min, max) {
  const parsed = Number(value)

  if (!Number.isFinite(parsed)) return min

  return Math.max(min, Math.min(max, parsed))
}

module.exports = {
  applyExpectedValues,
  commandExpectedValues,
  createRuntimeDevice,
  deviceSupportsAction,
  mutateTelemetryValues,
  oppositeExpectedValues,
}
