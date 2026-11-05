import { readVerifiedShellyEm1Status, shellyEm1StatusRpcUrl } from './shelly-em1-collection.adapter'

const target = { ipAddress: '192.0.2.20', physicalId: 'shellyproem50-001122334455', component: 'em1:0', channel: 0 }
const response = (body: unknown, status = 200) => ({ status, json: async () => body }) as Response
describe('Shelly EM1 read-only RPC adapter', () => {
  const originalFetch = global.fetch
  afterEach(() => { global.fetch = originalFetch })

  it('verifies physical identity before reading exactly EM1 channel 0 and maps act_power', async () => {
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(response({ id: target.physicalId, gen: 2 }))
      .mockResolvedValueOnce(response({ id: 0, act_power: 125.4, voltage: 231.0 }))
    global.fetch = mockFetch as unknown as typeof fetch
    const result = await readVerifiedShellyEm1Status(target, new AbortController().signal)
    expect(result).toMatchObject({ values: { power: 125.4 }, statusUrl: shellyEm1StatusRpcUrl(target.ipAddress, 0) })
    expect(Date.parse(result.observedAt)).not.toBeNaN()
    expect(mockFetch).toHaveBeenNthCalledWith(1, `http://${target.ipAddress}/rpc/Shelly.GetDeviceInfo`,
      expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) }))
    expect(mockFetch).toHaveBeenNthCalledWith(2, `http://${target.ipAddress}/rpc/EM1.GetStatus?id=0`,
      expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) }))
  })

  it('allows negative measured power, but never NaN or an invented zero', async () => {
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(response({ id: target.physicalId, gen: 2 }))
      .mockResolvedValueOnce(response({ id: 0, act_power: -20.5 }))
    global.fetch = mockFetch as unknown as typeof fetch
    expect((await readVerifiedShellyEm1Status(target, new AbortController().signal)).values.power).toBe(-20.5)
    for (const value of [null, undefined, '200', Number.NaN, Infinity]) {
      const nextFetch = jest.fn()
        .mockResolvedValueOnce(response({ id: target.physicalId, gen: 2 }))
        .mockResolvedValueOnce(response({ id: 0, act_power: value }))
      global.fetch = nextFetch as unknown as typeof fetch
      await expect(readVerifiedShellyEm1Status(target, new AbortController().signal)).rejects.toThrow('invalid_em1_status')
    }
  })

  it('rejects a wrong physical identity without requesting EM1 status', async () => {
    const mockFetch = jest.fn().mockResolvedValue(response({ id: 'shellyproem50-different', gen: 2 }))
    global.fetch = mockFetch as unknown as typeof fetch
    await expect(readVerifiedShellyEm1Status(target, new AbortController().signal)).rejects.toThrow('identity_mismatch')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('rejects a mismatched EM1 channel and an HTTP redirect', async () => {
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(response({ id: target.physicalId, gen: 2 }))
      .mockResolvedValueOnce(response({ id: 1, act_power: 98 }))
    global.fetch = mockFetch as unknown as typeof fetch
    await expect(readVerifiedShellyEm1Status(target, new AbortController().signal)).rejects.toThrow('invalid_em1_status')
    global.fetch = jest.fn().mockResolvedValue(response({}, 302)) as unknown as typeof fetch
    await expect(readVerifiedShellyEm1Status(target, new AbortController().signal)).rejects.toThrow('identity_http_302')
  })

  it('rejects invalid targets without network calls', async () => {
    const mockFetch = jest.fn()
    global.fetch = mockFetch as unknown as typeof fetch
    await expect(readVerifiedShellyEm1Status({ ...target, component: 'switch:0' }, new AbortController().signal))
      .rejects.toThrow('invalid_em1_target')
    await expect(readVerifiedShellyEm1Status({ ...target, ipAddress: '127.0.0.1/invalid' }, new AbortController().signal))
      .rejects.toThrow('invalid_em1_target')
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
