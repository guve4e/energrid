import { isShellyHttpEm1Approval, shellyHttpEm1Approval, SHELLY_HTTP_EM1_SOURCE } from './shelly-http-em1-observation-approval'

const deviceId = 'shellyproem50-8c4f00dbd258:em1:0'

describe('Shelly HTTP EM1 authority', () => {
  it('only authorizes normalized power for one exact channel, never switching', () => {
    const authority = shellyHttpEm1Approval(deviceId)
    expect(authority).toMatchObject({
      bindings: [{ deviceId, sourceId: SHELLY_HTTP_EM1_SOURCE, selector: 'EM1.GetStatus?id=0',
        fields: { power: { rawKey: 'power', type: 'number' } } }],
      policy: { deviceId, allowedSourcesByField: { power: ['shelly-http-em1'] } },
    })
    expect(authority.bindings[0].fields).not.toHaveProperty('on')
    expect(isShellyHttpEm1Approval(authority, deviceId)).toBe(true)
    expect(isShellyHttpEm1Approval({ ...authority, broker: 'mqtt.example:1883' }, deviceId)).toBe(false)
  })

  it('rejects switch IDs and unsupported channels', () => {
    expect(() => shellyHttpEm1Approval('shellyproem50-8c4f00dbd258:switch:0')).toThrow()
    expect(() => shellyHttpEm1Approval('shellyproem50-8c4f00dbd258:em1:32')).toThrow()
  })
})
