class SimulatorRegistry {
  constructor(simulators = []) {
    this.simulators = [...simulators]

    const ids = new Set()

    for (const simulator of this.simulators) {
      if (ids.has(simulator.id)) {
        throw new Error(`Duplicate simulator id: ${simulator.id}`)
      }

      ids.add(simulator.id)
    }
  }

  forDevice(device) {
    const simulator = this.simulators.find((candidate) =>
      candidate.supports(device),
    )

    if (!simulator) {
      throw new Error(
        `No Device Lab simulator supports protocol ${device.protocol} for ${device.id}`,
      )
    }

    return simulator
  }

  describe() {
    return this.simulators.map((simulator) => simulator.id)
  }
}

module.exports = {
  SimulatorRegistry,
}
