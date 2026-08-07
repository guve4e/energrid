class DeviceLabRegistryAnnouncer {
  constructor({
    publisher,
    devices,
    prefix,
    tenantId,
    siteId,
    siteName,
    gatewayId,
    registrationMode,
    publicBaseUrl,
    recordActivity = () => {},
  }) {
    this.publisher = publisher
    this.devices = devices
    this.prefix = prefix
    this.tenantId = tenantId
    this.siteId = siteId
    this.siteName = siteName
    this.gatewayId = gatewayId
    this.registrationMode = normalizeRegistrationMode(registrationMode)
    this.publicBaseUrl = String(publicBaseUrl).replace(/\/+$/, '')
    this.recordActivity = recordActivity

    this.lastAnnouncementAt = null
    this.lastError = null
    this.lastTopic = null
    this.lastDeviceCount = 0
  }

  snapshot() {
    return {
      mode: this.registrationMode,
      enabled: this.registrationMode === 'trusted',
      topic: `${this.prefix}/registry/devices`,
      retained: true,
      lastAnnouncementAt: this.lastAnnouncementAt,
      lastError: this.lastError,
      lastDeviceCount: this.lastDeviceCount,
    }
  }

  async announce(reason = 'manual registry announcement') {
    if (this.registrationMode !== 'trusted') {
      const result = {
        announced: false,
        mode: this.registrationMode,
        reason:
          'Registry announcement skipped because Device Lab is in discovery mode.',
      }

      this.recordActivity({
        kind: 'registry',
        stage: 'skipped',
        message: result.reason,
        details: {
          mode: this.registrationMode,
        },
      })

      return result
    }

    const topic = `${this.prefix}/registry/devices`
    const payload = this.createRegistryPayload()
    const startedAt = Date.now()

    try {
      const transport = await this.publisher.publish(topic, payload, {
        retain: true,
        qos: 1,
      })

      this.lastAnnouncementAt = new Date().toISOString()
      this.lastError = null
      this.lastTopic = topic
      this.lastDeviceCount = payload.devices.length

      this.recordActivity({
        kind: 'registry',
        stage: 'announced',
        topic,
        message: `Published trusted registry declaration for ${payload.devices.length} Device Lab devices.`,
        payload,
        details: {
          reason,
          retained: true,
          qos: 1,
          durationMs: Date.now() - startedAt,
        },
      })

      return {
        announced: true,
        mode: this.registrationMode,
        topic,
        retained: true,
        deviceCount: payload.devices.length,
        transport,
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error)

      this.lastError = message

      this.recordActivity({
        level: 'error',
        kind: 'registry',
        stage: 'failed',
        topic,
        message: `Registry announcement failed: ${message}`,
        details: {
          reason,
        },
      })

      throw error
    }
  }

  createRegistryPayload() {
    const observedAt = new Date().toISOString()

    return {
      tenantId: this.tenantId,
      siteId: this.siteId,
      siteName: this.siteName,
      gatewayId: this.gatewayId,
      observedAt,
      source: 'energrid-device-lab',
      trustedSimulator: true,
      devices: [...this.devices.values()].map((device) =>
        this.createDeviceDeclaration(device, observedAt),
      ),
    }
  }

  createDeviceDeclaration(device, observedAt) {
    const declaration = {
      id: device.id,
      deviceId: device.id,
      displayName: device.name,
      name: device.name,
      kind: 'physical',
      tenantId: this.tenantId,
      siteId: this.siteId,
      siteName: this.siteName,
      gatewayId: this.gatewayId,
      zoneName: device.zone || 'Device Lab',
      location: device.zone || 'Device Lab',
      origin: 'device-lab',
      protocol: device.protocol,
      transport: device.transport,
      driver: device.driver,
      bridge: device.bridge,
      configured: true,
      target: this.deviceTarget(device),
      capabilities: (device.capabilities || []).map(
        (capability) => capability.kind,
      ),
      values: {
        ...device.values,
      },
      state: {
        values: {
          ...device.values,
        },
        observedAt,
        source: `device-lab-${device.protocol}`,
        status: device.online ? 'online' : 'offline',
      },
      status: device.online ? 'online' : 'offline',
      metadata: {
        simulated: true,
        registrationMode: this.registrationMode,
      },
    }

    return removeUndefined(declaration)
  }

  deviceTarget(device) {
    if (device.protocol === 'http') {
      return `${this.publicBaseUrl}/devices/${encodeURIComponent(
        device.id,
      )}/state`
    }

    if (device.protocolConfig?.target) {
      return device.protocolConfig.target
    }

    if (device.protocol === 'zigbee') {
      return (
        device.protocolConfig?.topic ||
        `zigbee2mqtt/${device.id}`
      )
    }

    if (device.protocol === 'modbus') {
      return `${device.driver}:${Number(
        device.protocolConfig?.slaveId || 1,
      )}`
    }

    return device.id
  }
}

function normalizeRegistrationMode(value) {
  const normalized = String(value || 'discovery')
    .trim()
    .toLowerCase()

  if (normalized === 'trusted') return 'trusted'
  return 'discovery'
}

function removeUndefined(input) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  )
}

module.exports = {
  DeviceLabRegistryAnnouncer,
  normalizeRegistrationMode,
}
