const { DeviceSimulator } = require('../domain/device-simulator')

class ModbusDeviceSimulator extends DeviceSimulator {
  constructor({ publisher, prefix }) {
    super('modbus-device')
    this.publisher = publisher
    this.prefix = prefix
  }

  supports(device) {
    return device.protocol === 'modbus'
  }

  async publishObservation(device, observation) {
    const registerMap = device.protocolConfig?.registerMap || {}
    const registers = {}

    for (const [valueName, registerAddress] of Object.entries(registerMap)) {
      const value = observation.values[valueName]
      if (value === undefined || value === null) continue

      registers[registerAddress] = encodeRegisterValue(
        value,
        device.protocolConfig?.scales?.[valueName],
      )
    }

    const topic =
      device.protocolConfig?.observationTopic ||
      `${this.prefix}/adapters/modbus/observations`

    const payload = {
      adapter: 'modbus',
      deviceId: device.id,
      slaveId: Number(device.protocolConfig?.slaveId || 1),
      registers,
      observedAt: observation.observedAt,
      canonical: {
        deviceId: observation.deviceId,
        values: { ...observation.values },
        observedAt: observation.observedAt,
        receivedAt: observation.receivedAt,
        origin: observation.origin,
        protocol: observation.protocol,
        transport: observation.transport,
        status: observation.status,
        evidence: { ...observation.evidence },
      },
    }

    await this.publisher.publish(topic, payload)

    return {
      transported: true,
      transport: 'mqtt',
      nativeProtocol: 'modbus',
      topic,
      registerCount: Object.keys(registers).length,
      payload,
    }
  }
}

function encodeRegisterValue(value, configuredScale) {
  if (typeof value === 'boolean') return value ? 1 : 0

  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return value

  const scale = Number(configuredScale)
  return Number.isFinite(scale)
    ? Math.round(numeric * scale)
    : numeric
}

module.exports = {
  ModbusDeviceSimulator,
}
