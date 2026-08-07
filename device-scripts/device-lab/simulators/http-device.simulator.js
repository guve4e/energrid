const { DeviceSimulator } = require('../domain/device-simulator')

class HttpDeviceSimulator extends DeviceSimulator {
  constructor() {
    super('http-device')
  }

  supports(device) {
    return device.protocol === 'http'
  }

  async publishObservation() {
    return {
      transported: false,
      transport: 'http',
      reason: 'HTTP devices expose state for polling instead of publishing it',
    }
  }

  httpState(device, observation) {
    return {
      deviceId: device.id,
      values: { ...observation.values },
      observedAt: observation.observedAt,
      status: observation.status,
      protocol: 'http',
      evidence: observation.evidence,
    }
  }
}

module.exports = {
  HttpDeviceSimulator,
}
