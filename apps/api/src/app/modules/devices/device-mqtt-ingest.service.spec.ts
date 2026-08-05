import { firstValueFrom } from 'rxjs'
import { DeviceMqttIngestService } from './device-mqtt-ingest.service'
import { DeviceRegistryService } from './device-registry.service'

describe('DeviceMqttIngestService', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    process.env.PORTAL_TENANT_ID = 'valentin'
    process.env.PORTAL_SITE_ID = 'boyana-home'
    process.env.PORTAL_SITE_NAME = 'Boyana Home'
    process.env.HOME_MQTT_TOPIC_PREFIX = 'energrid/valentin/boyana-home'
    delete process.env.HOME_MQTT_INGEST_ENABLED
    delete process.env.HOME_MQTT_DEBUG_TOPICS
    delete process.env.HOME_MQTT_LEGACY_TEMPERATURE_TOPICS
    delete process.env.HOME_MQTT_LEGACY_DEVICE_TOPICS
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('maps legacy Arduino temperature topics into approved registry devices', () => {
    const registry = new DeviceRegistryService()
    const service = new DeviceMqttIngestService(registry)

    service['handleLine'](
      'sensors/arduino/temp {"temperature":23.5,"humidity":48.2,"timestamp":"2026-08-03T10:15:00.000Z"}',
    )
    service['handleLine'](
      'sensors/arduino/temp2 {"temperature":31.5,"humidity":56.1,"timestamp":"2026-08-03T10:16:00.000Z"}',
    )

    const devices = registry.getDevices()
    const kitchen = devices.find((device) => device.id === 'kitchen_temperature')
    const garage = devices.find((device) => device.id === 'garage_temperature')

    expect(kitchen).toEqual(
      expect.objectContaining({
        displayName: 'Kitchen temperature',
        trustStatus: 'approved',
        state: expect.objectContaining({
          values: { temperature: 23.5, humidity: 48.2 },
          status: 'online',
        }),
      }),
    )
    expect(garage).toEqual(
      expect.objectContaining({
        displayName: 'Garage temperature',
        trustStatus: 'approved',
        state: expect.objectContaining({
          values: { temperature: 31.5, humidity: 56.1 },
          status: 'online',
        }),
      }),
    )
  })

  it('keeps a recent MQTT debug trace for handled and ignored messages', () => {
    const registry = new DeviceRegistryService()
    const service = new DeviceMqttIngestService(registry)

    service['handleLine'](
      'energrid/valentin/boyana-home/devices/kitchen_temperature/telemetry {"deviceId":"kitchen_temperature","values":{"temperature":24.1}}',
    )
    service['handleLine']('energrid/valentin/boyana-home/debug/raw hello')

    const state = service.getDebugState()

    expect(state.status).toBe('disabled')
    expect(state.prefix).toBe('energrid/valentin/boyana-home')
    expect(state.recentMessages).toEqual([
      expect.objectContaining({
        topic: 'energrid/valentin/boyana-home/debug/raw',
        validJson: false,
        handled: false,
        reason: 'ignored non-json',
      }),
      expect.objectContaining({
        topic: 'energrid/valentin/boyana-home/devices/kitchen_temperature/telemetry',
        validJson: true,
        handled: true,
        reason: 'device telemetry',
      }),
    ])
  })

  it('subscribes to the legacy framework device branch by default', () => {
    const registry = new DeviceRegistryService()
    const service = new DeviceMqttIngestService(registry)

    expect(service.getDebugState().subscriptions).toEqual(
      expect.arrayContaining(['energrid/valentin/boyana-home/#', 'devices/#']),
    )
    expect(service.getDebugState().legacyDeviceTopics).toEqual(['devices/#'])
  })

  it('maps legacy framework device status topics into approved read-only devices', () => {
    const registry = new DeviceRegistryService()
    const service = new DeviceMqttIngestService(registry)

    service['handleLine'](
      'devices/temp-kitchen/status {"deviceId":"temp-kitchen","name":"ESP8266 Temp Sensor","type":"sensor","firmwareVersion":"1.1.0","location":"garage","temperature":{"value":23.5},"humidity":{"value":48.1},"config":{"readings":{"temperature":{"enabled":true,"unit":"°C"},"humidity":{"enabled":true,"unit":"%"}}}}',
    )
    service['handleLine'](
      'devices/ac/status {"deviceId":"ac","name":"ac","type":"power-sensor","location":"DIN","power":{"value":3347.2},"current":{"value":1.824},"energy_delta":{"value":0.034636}}',
    )

    const devices = registry.getDevices()
    const kitchen = devices.find((device) => device.id === 'temp-kitchen')
    const ac = devices.find((device) => device.id === 'ac')

    expect(kitchen).toEqual(
      expect.objectContaining({
        displayName: 'ESP8266 Temp Sensor',
        zoneName: 'Kitchen',
        trustStatus: 'approved',
        capabilities: expect.arrayContaining([
          expect.objectContaining({ kind: 'temperature', actions: ['read'] }),
          expect.objectContaining({ kind: 'humidity', actions: ['read'] }),
        ]),
        adapter: expect.objectContaining({ driver: 'legacy-framework-device' }),
        state: expect.objectContaining({
          values: { temperature: 23.5, humidity: 48.1 },
          source: 'legacy',
          status: 'online',
        }),
      }),
    )
    expect(ac).toEqual(
      expect.objectContaining({
        zoneName: 'DIN',
        capabilities: [expect.objectContaining({ kind: 'power', actions: ['read'] })],
        state: expect.objectContaining({
          values: { power: 3347.2, current: 1.824, energy_delta: 0.034636 },
        }),
      }),
    )
  })

  it('uses legacy online topics only as status updates for existing devices', () => {
    const registry = new DeviceRegistryService()
    const service = new DeviceMqttIngestService(registry)

    service['handleLine'](
      'devices/temp-garage/status {"deviceId":"temp-garage","name":"ESP8266 Temp Sensor","type":"sensor","temperature":31.5}',
    )
    service['handleLine']('devices/temp-garage/online false')

    const devices = registry.getDevices()
    const garage = devices.find((device) => device.id === 'temp-garage')

    expect(garage?.state.status).toBe('offline')
    expect(devices.find((device) => device.id === 'unknown-online-only')).toBeUndefined()
  })

  it('emits live MQTT debug messages as they are recorded', async () => {
    const registry = new DeviceRegistryService()
    const service = new DeviceMqttIngestService(registry)
    const nextMessage = firstValueFrom(service.streamDebugMessages())

    service['handleLine'](
      'energrid/valentin/boyana-home/devices/kitchen_temperature/status {"deviceId":"kitchen_temperature","status":"online"}',
    )

    await expect(nextMessage).resolves.toEqual(
      expect.objectContaining({
        topic: 'energrid/valentin/boyana-home/devices/kitchen_temperature/status',
        validJson: true,
        handled: true,
        reason: 'device status',
      }),
    )
  })
})
