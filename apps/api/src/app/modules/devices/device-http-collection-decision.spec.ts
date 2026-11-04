import {
  explainScheduledHttpCollection,
  selectScheduledHttpCollection,
} from './device-http-poll.service'
import type { RegisteredDevice } from './device-registry.types'

function device(input: {
  id?: string
  trustStatus?: 'approved' | 'discovered'
  protocol?: 'http' | 'mqtt'
  driver?: string
  configured?: boolean
  target?: string
  kind?: 'physical' | 'logical'
} = {}): RegisteredDevice {
  return {
    id: input.id ?? 'device:generic',
    trustStatus: input.trustStatus ?? 'approved',
    kind: input.kind ?? 'physical',
    adapter: {
      protocol: input.protocol ?? 'http',
      driver: input.driver ?? 'generic-http',
      configured: input.configured ?? true,
      target: input.target ?? 'http://127.0.0.1/status',
    },
  } as RegisteredDevice
}

describe('scheduled HTTP collection explanations', () => {
  it('selects exactly the devices reported eligible by the explanation', () => {
    const esp = device({ id: 'device:upstream-lan:esp8266:324864', driver: 'energrid-esp8266', configured: false })
    const shellyMqtt = device({ id: 'shellypro2pm-ec6260888084:switch:0', driver: 'shelly-discovered', protocol: 'mqtt' })
    const shellyHttp = device({ id: 'shellypro2pm-ec6260888084:switch:1', driver: 'shelly-lan' })
    const em = device({ id: 'shellyproem50-08f9e0e84910:em1:0', driver: 'shelly-lan' })
    const blocked = device({ id: 'blocked', trustStatus: 'discovered' })
    const devices = [esp, shellyMqtt, shellyHttp, em, blocked]
    const scheduled = selectScheduledHttpCollection(devices)

    expect(scheduled.httpDevices).toEqual(devices.filter(item => explainScheduledHttpCollection(item).httpRead.selected))
    expect(scheduled.shellySwitches).toEqual(devices.filter(item => explainScheduledHttpCollection(item).operationalStatusRead.selected))
    expect(explainScheduledHttpCollection(shellyMqtt)).toEqual({
      httpRead: { selected: false, reason: 'adapter_not_http' },
      operationalStatusRead: { selected: true, reason: 'identity_checked_switch_candidate' },
    })
    // Preserve and expose the current overlap instead of silently changing behavior.
    expect(explainScheduledHttpCollection(shellyHttp).httpRead.selected).toBe(true)
    expect(explainScheduledHttpCollection(shellyHttp).operationalStatusRead.selected).toBe(true)
    // Legacy EM1 HTTP eligibility does not imply the existing parser understands EM1.
    expect(explainScheduledHttpCollection(em).httpRead.selected).toBe(true)
    expect(explainScheduledHttpCollection(em).operationalStatusRead.selected).toBe(false)
    expect(explainScheduledHttpCollection(blocked).httpRead.reason).toBe('device_not_approved')
  })

  it('distinguishes a missing HTTP target from an unconfigured adapter', () => {
    expect(explainScheduledHttpCollection(device({ target: 'not-a-url' })).httpRead.reason)
      .toBe('http_target_missing')
    expect(explainScheduledHttpCollection(device({ configured: false })).httpRead.reason)
      .toBe('adapter_not_configured')
  })
})
