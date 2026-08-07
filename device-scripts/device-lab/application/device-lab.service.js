const {
  applyExpectedValues,
  commandExpectedValues,
  deviceSupportsAction,
  mutateTelemetryValues,
  oppositeExpectedValues,
} = require('../device-lab-device')

class DeviceLabService {
  constructor({
    devices,
    simulatorRegistry,
    broker,
    recordActivity = () => {},
  }) {
    this.devices = devices
    this.simulatorRegistry = simulatorRegistry
    this.broker = broker
    this.recordGlobalActivity = recordActivity
    this.telemetryTimers = new Map()
  }

  snapshot() {
    return {
      broker: { ...this.broker },
      simulators: this.simulatorRegistry.describe(),
      devices: [...this.devices.values()].map((device) =>
        this.publicDevice(device),
      ),
    }
  }

  publicDevice(device) {
    return {
      ...device,
      activity: [...device.activity],
    }
  }

  requireDevice(id) {
    const device = this.devices.get(id)

    if (!device) {
      const error = new Error(`Unknown device ${id}`)
      error.statusCode = 404
      throw error
    }

    return device
  }

  startAll() {
    for (const device of this.devices.values()) {
      if (device.telemetry.enabled) {
        this.startTelemetry(device.id, {
          initialDelayMs: device.telemetry.initialDelayMs,
        })
      }
    }
  }

  stopAll() {
    for (const device of this.devices.values()) {
      this.stopTelemetry(device.id, 'Device Lab stopped')
    }
  }

  updateBehavior(id, input) {
    const device = this.requireDevice(id)

    device.behavior = {
      ...device.behavior,
      ...normalizeBehavior(input),
    }

    this.recordDeviceActivity(device, {
      kind: 'configuration',
      stage: 'behavior-updated',
      message: 'Runtime behavior updated.',
      details: device.behavior,
    })

    return this.publicDevice(device)
  }

  updateTelemetry(id, input) {
    const device = this.requireDevice(id)
    const wasEnabled = device.telemetry.enabled

    device.telemetry = {
      ...device.telemetry,
      ...normalizeTelemetry(input),
      variation: {
        ...device.telemetry.variation,
        ...normalizeVariation(input?.variation),
      },
    }

    this.recordDeviceActivity(device, {
      kind: 'configuration',
      stage: 'telemetry-updated',
      message: 'Telemetry configuration updated.',
      details: {
        enabled: device.telemetry.enabled,
        intervalMs: device.telemetry.intervalMs,
        variation: JSON.stringify(device.telemetry.variation),
      },
    })

    if (!device.telemetry.enabled) {
      this.stopTelemetry(device.id, 'Telemetry disabled')
    } else if (
      !wasEnabled ||
      !this.telemetryTimers.has(device.id)
    ) {
      this.startTelemetry(device.id)
    } else {
      this.restartTelemetry(device.id)
    }

    return this.publicDevice(device)
  }

  startTelemetry(id, options = {}) {
    const device = this.requireDevice(id)

    this.clearTelemetryTimer(device.id)

    device.telemetry.enabled = true
    device.telemetry.status = 'running'
    device.telemetry.lastStartedAt = new Date().toISOString()
    device.telemetry.lastStoppedAt = null
    device.telemetry.lastError = null

    this.recordDeviceActivity(device, {
      kind: 'lifecycle',
      stage: 'started',
      message: `Autonomous telemetry started every ${device.telemetry.intervalMs}ms.`,
    })

    const initialDelayMs = Number.isFinite(Number(options.initialDelayMs))
      ? Math.max(0, Number(options.initialDelayMs))
      : Math.min(device.telemetry.intervalMs, 500)

    this.scheduleNextTelemetry(device, initialDelayMs)

    return this.publicDevice(device)
  }

  stopTelemetry(id, reason = 'Telemetry paused') {
    const device = this.requireDevice(id)

    this.clearTelemetryTimer(device.id)

    device.telemetry.status = 'paused'
    device.telemetry.lastStoppedAt = new Date().toISOString()
    device.telemetry.nextEmissionAt = null

    this.recordDeviceActivity(device, {
      kind: 'lifecycle',
      stage: 'paused',
      message: reason,
    })

    return this.publicDevice(device)
  }

  restartTelemetry(id) {
    const device = this.requireDevice(id)

    this.stopTelemetry(id, 'Telemetry restarting')
    device.telemetry.sequence = 0

    return this.startTelemetry(id, {
      initialDelayMs: 100,
    })
  }

  async emitNow(id, reason = 'manual emit now') {
    const device = this.requireDevice(id)

    return this.emitAutonomousObservation(device, reason)
  }

  scheduleNextTelemetry(device, delayMs = device.telemetry.intervalMs) {
    if (!device.telemetry.enabled || device.telemetry.status !== 'running') {
      return
    }

    const normalizedDelay = Math.max(250, Number(delayMs) || 5000)

    device.telemetry.nextEmissionAt = new Date(
      Date.now() + normalizedDelay,
    ).toISOString()

    const timer = setTimeout(async () => {
      this.telemetryTimers.delete(device.id)

      try {
        await this.emitAutonomousObservation(
          device,
          'scheduled autonomous telemetry',
        )
      } catch {
        // The failure has already been captured in device activity.
      } finally {
        if (
          device.telemetry.enabled &&
          device.telemetry.status === 'running'
        ) {
          this.scheduleNextTelemetry(
            device,
            device.telemetry.intervalMs,
          )
        }
      }
    }, normalizedDelay)

    this.telemetryTimers.set(device.id, timer)
  }

  clearTelemetryTimer(deviceId) {
    const timer = this.telemetryTimers.get(deviceId)

    if (timer) {
      clearTimeout(timer)
      this.telemetryTimers.delete(deviceId)
    }
  }

  async emitAutonomousObservation(device, reason) {
    device.telemetry.sequence += 1

    if (device.online) {
      mutateTelemetryValues(device)
    }

    this.recordDeviceActivity(device, {
      kind: 'telemetry',
      stage: 'preparing',
      message: device.online
        ? `Preparing autonomous observation #${device.telemetry.sequence}.`
        : `Preparing offline status observation #${device.telemetry.sequence}.`,
      details: {
        values: JSON.stringify(device.values),
      },
    })

    try {
      const observation = await this.publishObservation(device, {
        reason,
      })

      device.telemetry.lastEmissionAt = new Date().toISOString()
      device.telemetry.lastError = null

      const evidence = observation.transportEvidence || {}

      this.recordDeviceActivity(device, {
        kind: 'telemetry',
        stage: evidence.transported ? 'transported' : 'available',
        topic: evidence.topic || null,
        message: evidence.transported
          ? `Observation transported through ${evidence.transport}.`
          : evidence.reason || 'Observation is available for polling.',
        payload: evidence.payload || observation,
        details: {
          sequence: device.telemetry.sequence,
          transport: evidence.transport || device.transport,
          nativeProtocol: evidence.nativeProtocol || device.protocol,
        },
      })

      return observation
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error)

      device.telemetry.lastError = message

      this.recordDeviceActivity(device, {
        level: 'error',
        kind: 'telemetry',
        stage: 'failed',
        message,
      })

      throw error
    }
  }

  async setOnline(id, online) {
    const device = this.requireDevice(id)
    device.online = Boolean(online)

    this.recordDeviceActivity(device, {
      kind: 'lifecycle',
      stage: device.online ? 'online' : 'offline',
      message: `${device.name} changed to ${
        device.online ? 'online' : 'offline'
      }.`,
    })

    await this.publishObservation(device, {
      reason: 'online state changed from device lab',
    })

    return this.publicDevice(device)
  }

  async observe(id, values = {}) {
    const device = this.requireDevice(id)

    for (const [key, value] of Object.entries(values)) {
      if (isPrimitive(value)) {
        device.values[key] = value
      }
    }

    const observation = await this.publishObservation(device, {
      reason: 'manual observation',
    })

    this.recordDeviceActivity(device, {
      kind: 'telemetry',
      stage: 'manual',
      topic: observation.transportEvidence?.topic || null,
      message: 'Manual observation emitted.',
      payload: observation,
    })

    return this.publicDevice(device)
  }

  async executeCommand(id, commandInput) {
    const device = this.requireDevice(id)
    const command = normalizeCommand(commandInput)

    if (!deviceSupportsAction(device, command.action)) {
      this.recordDeviceActivity(device, {
        level: 'warn',
        kind: 'command',
        stage: 'rejected',
        message: `${device.name} does not support ${command.action}.`,
      })

      return {
        accepted: false,
        deviceId: device.id,
        stage: 'rejected',
        message: `${device.name} does not support ${command.action}`,
      }
    }

    return this.executeSimulatedCommand(device, command)
  }

  getHttpState(id) {
    const device = this.requireDevice(id)

    if (!device.online) {
      const error = new Error(`${device.name} is offline`)
      error.statusCode = 503
      throw error
    }

    const observation = this.createObservation(device, {
      reason: 'HTTP state poll',
    })

    this.recordDeviceActivity(device, {
      kind: 'http',
      stage: 'polled',
      message: 'HTTP client fetched current device state.',
      payload: observation,
    })

    return this.simulatorRegistry
      .forDevice(device)
      .httpState(device, observation)
  }

  async executeSimulatedCommand(device, command) {
    const generatedCommandId =
      `${device.id}:${Date.now()}:${++device.sequence}`

    const commandId =
      typeof command.commandId === 'string' && command.commandId.trim()
        ? command.commandId.trim()
        : generatedCommandId

    const expectedValues = commandExpectedValues(device, command)

    device.lastCommand = {
      id: commandId,
      action: command.action,
      requestedAt: new Date().toISOString(),
      expectedValues,
      stage: 'accepted',
    }

    this.recordDeviceActivity(device, {
      kind: 'command',
      stage: 'accepted',
      message: `${command.action} accepted by Device Lab.`,
      details: {
        commandId,
        expectedValues: JSON.stringify(expectedValues),
      },
    })

    if (!device.online) {
      return this.rejectCommand(device, commandId, 'Device is offline')
    }

    if (device.behavior.rejectCommand) {
      return this.rejectCommand(
        device,
        commandId,
        'Device rejected the command',
      )
    }

    device.lastCommand.stage = 'transported'

    this.recordDeviceActivity(device, {
      kind: 'command',
      stage: 'transported',
      message: `Command transported to the ${device.protocol} simulator.`,
      details: {
        commandId,
      },
    })

    schedule(device.behavior.delayMs, async () => {
      if (device.behavior.dropAcknowledgement) {
        this.recordDeviceActivity(device, {
          level: 'warn',
          kind: 'command',
          stage: 'ack-dropped',
          message: 'The simulated device intentionally emitted no acknowledgement.',
          details: {
            commandId,
          },
        })

        return
      }

      const reportedValues = device.behavior.reportOppositeState
        ? oppositeExpectedValues(expectedValues)
        : expectedValues

      applyExpectedValues(device, reportedValues)
      device.lastCommand.stage = 'reported'

      await this.publishObservation(device, {
        commandId,
        action: command.action,
        expectedValues,
        reason: 'simulated command result',
      })

      this.recordDeviceActivity(device, {
        kind: 'command',
        stage: 'reported',
        message: 'Device reported state after the command.',
        details: {
          commandId,
          reportedValues: JSON.stringify(reportedValues),
        },
      })

      if (device.behavior.unstableForMs > 0) {
        schedule(device.behavior.unstableForMs, async () => {
          applyExpectedValues(device, expectedValues)

          await this.publishObservation(device, {
            commandId,
            action: command.action,
            expectedValues,
            reason: 'device became stable',
          })

          this.recordDeviceActivity(device, {
            kind: 'command',
            stage: 'settled',
            message: 'Device returned to the requested stable state.',
            details: {
              commandId,
            },
          })
        })
      }

      if (device.behavior.driftAfterMs > 0) {
        schedule(device.behavior.driftAfterMs, async () => {
          applyExpectedValues(
            device,
            oppositeExpectedValues(expectedValues),
          )

          await this.publishObservation(device, {
            commandId,
            action: command.action,
            expectedValues,
            reason: 'simulated state drift',
          })

          this.recordDeviceActivity(device, {
            level: 'warn',
            kind: 'command',
            stage: 'drifted',
            message: 'Device drifted away from the requested state.',
            details: {
              commandId,
            },
          })
        })
      }
    })

    return {
      accepted: true,
      commandId,
      deviceId: device.id,
      stage: 'transported',
      action: command.action,
      expectedValues,
    }
  }

  rejectCommand(device, commandId, message) {
    device.lastCommand.stage = 'rejected'
    device.lastCommand.message = message

    this.recordDeviceActivity(device, {
      level: 'warn',
      kind: 'command',
      stage: 'rejected',
      message,
      details: {
        commandId,
      },
    })

    return {
      accepted: false,
      commandId,
      deviceId: device.id,
      stage: 'rejected',
      message,
    }
  }

  createObservation(device, context = {}) {
    const observedAt = device.behavior.staleTelemetry
      ? new Date(Date.now() - 60_000).toISOString()
      : new Date().toISOString()

    return {
      deviceId: device.id,
      values: { ...device.values },
      observedAt,
      receivedAt: new Date().toISOString(),
      origin: `device-lab-${device.protocol}`,
      protocol: device.protocol,
      transport: device.transport,
      status: device.online ? 'online' : 'offline',
      evidence: {
        commandId: context.commandId || null,
        action: context.action || null,
        expectedValues: context.expectedValues || null,
        reason: context.reason || 'device observation',
        simulated: true,
      },
    }
  }

  async publishObservation(device, context = {}) {
    const observation = this.createObservation(device, context)
    const simulator = this.simulatorRegistry.forDevice(device)

    try {
      const transportEvidence =
        await simulator.publishObservation(device, observation)

      observation.transportEvidence =
        cloneTransportEvidence(transportEvidence)
    } catch (error) {
      observation.transportEvidence = {
        transported: false,
        error: error instanceof Error ? error.message : String(error),
      }

      device.lastObservation = observation
      throw error
    }

    device.lastObservation = observation
    return observation
  }

  recordDeviceActivity(device, input) {
    const event = {
      id: `${device.id}:${Date.now()}:${device.activity.length + 1}`,
      observedAt: new Date().toISOString(),
      level: input.level || 'info',
      kind: input.kind || 'activity',
      stage: input.stage || null,
      deviceId: device.id,
      topic: input.topic || null,
      message: input.message || '',
      payload: input.payload ?? null,
      details: input.details || {},
    }

    device.activity.unshift(event)

    const maxEvents = Number(
      process.env.DEVICE_LAB_DEVICE_MAX_EVENTS || 60,
    )

    if (device.activity.length > maxEvents) {
      device.activity.splice(maxEvents)
    }

    this.recordGlobalActivity(event)

    return event
  }
}

function cloneTransportEvidence(value) {
  if (value === undefined) return undefined

  if (typeof structuredClone === 'function') {
    return structuredClone(value)
  }

  return JSON.parse(JSON.stringify(value))
}

function normalizeCommand(input) {
  if (!input || typeof input !== 'object') {
    return { action: '' }
  }

  if (typeof input.action === 'string') {
    return {
      commandId:
        typeof input.commandId === 'string'
          ? input.commandId
          : undefined,
      action: input.action,
      level: input.level,
    }
  }

  if (typeof input.on === 'boolean') {
    return {
      action: input.on ? 'turn_on' : 'turn_off',
    }
  }

  return {
    action: '',
  }
}

function normalizeBehavior(input) {
  const next = {}

  for (const key of ['delayMs', 'driftAfterMs', 'unstableForMs']) {
    if (Number.isFinite(Number(input?.[key]))) {
      next[key] = Math.max(0, Number(input[key]))
    }
  }

  for (const key of [
    'dropAcknowledgement',
    'rejectCommand',
    'reportOppositeState',
    'staleTelemetry',
  ]) {
    if (typeof input?.[key] === 'boolean') {
      next[key] = input[key]
    }
  }

  return next
}

function normalizeTelemetry(input) {
  const next = {}

  if (typeof input?.enabled === 'boolean') {
    next.enabled = input.enabled
  }

  if (Number.isFinite(Number(input?.intervalMs))) {
    next.intervalMs = Math.max(250, Number(input.intervalMs))
  }

  return next
}

function normalizeVariation(input) {
  if (!input || typeof input !== 'object') return {}

  const variation = {}

  for (const [key, value] of Object.entries(input)) {
    const parsed = Number(value)

    if (Number.isFinite(parsed) && parsed >= 0) {
      variation[key] = parsed
    }
  }

  return variation
}

function schedule(delayMs, callback) {
  setTimeout(() => {
    Promise.resolve(callback()).catch((error) => {
      console.error('[DEVICE LAB ASYNC ERROR]', error)
    })
  }, Math.max(0, Number(delayMs) || 0))
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
  DeviceLabService,
  normalizeBehavior,
  normalizeCommand,
}
