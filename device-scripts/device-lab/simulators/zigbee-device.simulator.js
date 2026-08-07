const { DeviceSimulator } = require('../domain/device-simulator')

class ZigbeeDeviceSimulator extends DeviceSimulator {
  constructor({ publisher }) {
    super('zigbee2mqtt-device')
    this.publisher = publisher
  }

  supports(device) {
    return device.protocol === 'zigbee'
  }

  async publishObservation(device, observation) {
    const topic =
      device.protocolConfig?.topic ||
      `zigbee2mqtt/${device.id}`

    const payload = {
      ...observation.values,
      state: booleanState(observation.values),
      linkquality:
        observation.status === 'online'
          ? Number(observation.values.linkquality ?? 120)
          : 0,
      last_seen: observation.observedAt,
    }

    delete payload.on
    delete payload.open

    await this.publisher.publish(topic, payload)

    return {
      transported: true,
      transport: 'mqtt',
      nativeProtocol: 'zigbee',
      topic,
      payload,
    }
  }
}

function booleanState(values) {
  if (typeof values.on === 'boolean') {
    return values.on ? 'ON' : 'OFF'
  }

  if (typeof values.open === 'boolean') {
    return values.open ? 'OPEN' : 'CLOSE'
  }

  return undefined
}

module.exports = {
  ZigbeeDeviceSimulator,
}
