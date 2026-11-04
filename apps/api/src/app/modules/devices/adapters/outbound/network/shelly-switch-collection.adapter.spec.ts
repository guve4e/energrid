import type { RegisteredDevice } from '../../../device-registry.types'
import {
  isShellySwitchCollectionCandidate,
  readVerifiedShellySwitchStatus,
  shellySwitchStatusRpcUrl,
} from './shelly-switch-collection.adapter'

const target = {
  ipAddress: '192.0.2.20',
  physicalId: 'shellypro2pm-001122334455',
  component: 'switch:0',
  channel: 0,
}

const mockResponse = (body: unknown, status = 200) => ({
  status,
  json: async () => body,
}) as Response

const candidate = (id: string, driver: string, trustStatus = 'approved') => ({
  id, kind: 'physical', trustStatus,
  adapter: { driver },
}) as unknown as RegisteredDevice

describe('Shelly switch collection adapter', () => {
  const originalFetch = global.fetch
  afterEach(() => { global.fetch = originalFetch })

  it('selects only approved switch components, never EM measurements', () => {
    expect(isShellySwitchCollectionCandidate(candidate(`${target.physicalId}:switch:0`, 'shelly-lan'))).toBe(true)
    expect(isShellySwitchCollectionCandidate(candidate(`${target.physicalId}:switch:1`, 'shelly-discovered'))).toBe(true)
    expect(isShellySwitchCollectionCandidate(candidate(`${target.physicalId}:em1:0`, 'shelly-lan'))).toBe(false)
    expect(isShellySwitchCollectionCandidate(candidate(`${target.physicalId}:switch:0`, 'shelly-lan', 'discovered'))).toBe(false)
    expect(isShellySwitchCollectionCandidate(candidate('other:switch:0', 'shelly-lan'))).toBe(false)
  })

  it('verifies identity before reading the exact switch and handles output=false', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(mockResponse({ id: target.physicalId, gen: 2 }))
      .mockResolvedValueOnce(mockResponse({ id: 0, output: false }))
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await readVerifiedShellySwitchStatus(target, new AbortController().signal)
    expect(result).toMatchObject({ values: { on: false }, statusUrl: shellySwitchStatusRpcUrl(target.ipAddress, 0) })
    expect(Date.parse(result.observedAt)).not.toBeNaN()
    expect(fetchMock).toHaveBeenNthCalledWith(1,
      `http://${target.ipAddress}/rpc/Shelly.GetDeviceInfo`,
      expect.objectContaining({ redirect: 'manual', cache: 'no-store', signal: expect.any(AbortSignal) }))
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      `http://${target.ipAddress}/rpc/Switch.GetStatus?id=0`,
      expect.objectContaining({ redirect: 'manual', cache: 'no-store', signal: expect.any(AbortSignal) }))
  })

  it('rejects identity mismatch without calling status RPC', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockResponse({ id: 'another-device', gen: 2 }))
    global.fetch = fetchMock as unknown as typeof fetch
    await expect(readVerifiedShellySwitchStatus(target, new AbortController().signal)).rejects.toThrow('identity_mismatch')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a mismatched component response instead of inventing a relay state', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(mockResponse({ id: target.physicalId, gen: 2 }))
      .mockResolvedValueOnce(mockResponse({ id: 1, output: true }))
    global.fetch = fetchMock as unknown as typeof fetch
    await expect(readVerifiedShellySwitchStatus(target, new AbortController().signal)).rejects.toThrow('invalid_switch_status')
  })
})
