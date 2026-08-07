const { DeviceSimulator } = require('../domain/device-simulator')

class MqttDeviceSimulator extends DeviceSimulator {
  constructor({ publisher, prefix }) {
    super('mqtt-device')
    this.publisher = publisher
    this.prefix = prefix
  }

  supports(device) {
    return device.protocol === 'mqtt'
  }

  async publishObservation(device, observation) {
    const topic =
      device.protocolConfig?.telemetryTopic ||
      `${this.prefix}/devices/${topicDeviceId(device.id)}/telemetry`

    await this.publisher.publish(topic, observation)

    return {
      transported: true,
      transport: 'mqtt',
      topic,
      payload: {
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
  }
}

function topicDeviceId(value) {
  return String(value).replace(/\./g, '_')
}

module.exports = {
  MqttDeviceSimulator,
}
