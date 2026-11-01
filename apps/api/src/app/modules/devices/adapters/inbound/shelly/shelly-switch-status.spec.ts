import { parseShellySwitchStatus } from './shelly-switch-status'

describe('parseShellySwitchStatus', () => {
  it.each([true, false])('preserves output=%s', output => {
    expect(parseShellySwitchStatus({ id: 0, output }, 'switch:0')).toEqual({ on: output })
  })

  it.each([
    null,
    [],
    {},
    { id: 1, output: true },
    { id: 0, output: 'true' },
    { id: 0, output: null },
  ])('rejects malformed or mismatched status %#', value => {
    expect(parseShellySwitchStatus(value, 'switch:0')).toBeNull()
  })
})
