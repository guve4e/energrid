export function ipv4NetmaskPrefix(netmask: string): number | null {
  const octets = netmask.split('.').map(Number)
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null
  const bits = octets.map(value => value.toString(2).padStart(8, '0')).join('')
  if (!/^1*0*$/.test(bits)) return null
  return bits.indexOf('0') === -1 ? 32 : bits.indexOf('0')
}
