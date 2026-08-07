const assert = require('node:assert/strict')
const test = require('node:test')

const {
  DeviceLabService,
} = require('../application/device-lab.service')
const {
  createRuntimeDevice,
} = require('../device-lab-device')
const {
  SimulatorRegistry,
} = require('../infrastructure/simulator-registry')
const {
  DeviceSimulator,
} = require('../domain/device-simulator')

class RecordingSimulator extends DeviceSimulator {
  constructor() {
    super('recording')
    this.observations = []
  }

  supports() {
    return true
  }

  async publishObservation(device, observation) {
    this.observations.push({
      deviceId: device.id,
      observation,
    })

    return {
      transported: true,
      transport: 'test',
    }
  }
}

function fixture() {
  const device = createRuntimeDevice({
    id: 'test.relay',
    name: 'Test relay',
    protocol: 'mqtt',
    driver: 'test',
    capabilities: [
      {
        kind: 'switch',
        actions: ['turn_on', 'turn_off', 'read'],
      },
    ],
    initialValues: {
      on: false,
    },
  })

  device.behavior.delayMs = 0

  const simulator = new RecordingSimulator()

  const service = new DeviceLabService({
    devices: new Map([[device.id, device]]),
    simulatorRegistry: new SimulatorRegistry([simulator]),
    broker: {
      host: 'localhost',
      port: '1883',
      prefix: 'energrid/test/site',
    },
  })

  return {
    service,
    simulator,
    device,
  }
}

test('executes a supported command and publishes evidence', async () => {
  const { service, simulator, device } = fixture()

  const result = await service.executeCommand(device.id, {
    action: 'turn_on',
  })

  assert.equal(result.accepted, true)
  assert.equal(result.stage, 'transported')
  assert.deepEqual(result.expectedValues, { on: true })

  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(device.values.on, true)
  assert.equal(device.lastCommand.stage, 'reported')
  assert.equal(simulator.observations.length, 1)
  assert.equal(
    simulator.observations[0].observation.evidence.action,
    'turn_on',
  )
})

test('rejects unsupported capabilities', async () => {
  const { service, device } = fixture()

  const result = await service.executeCommand(device.id, {
    action: 'open',
  })

  assert.equal(result.accepted, false)
  assert.equal(result.stage, 'rejected')
})

test('can deliberately drop acknowledgement', async () => {
  const { service, simulator, device } = fixture()

  device.behavior.dropAcknowledgement = true

  const result = await service.executeCommand(device.id, {
    action: 'turn_on',
  })

  assert.equal(result.accepted, true)

  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(device.values.on, false)
  assert.equal(device.lastCommand.stage, 'transported')
  assert.equal(simulator.observations.length, 0)
})
