class DeviceSimulator {
  constructor(id) {
    if (!id) throw new Error('Simulator id is required')
    this.id = id
  }

  supports(_device) {
    return false
  }

  async publishObservation(_device, _observation) {
    throw new Error(`${this.id} does not implement publishObservation()`)
  }

  httpState(device, observation) {
    return {
      deviceId: device.id,
      values: { ...observation.values },
      observedAt: observation.observedAt,
      status: observation.status,
    }
  }
}

module.exports = {
  DeviceSimulator,
}
