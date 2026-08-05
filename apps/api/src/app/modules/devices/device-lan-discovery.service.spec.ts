import {
  candidateBelongsToConfiguredZone,
  ipInCidr,
  ipsInCidr,
  parseArpOutput,
  parseNetworkZones,
  parseRouterClientsJson,
} from './device-lan-discovery.service'

describe('parseArpOutput', () => {
  it('parses macOS arp output', () => {
    expect(
      parseArpOutput('? (192.168.1.60) at dc:a6:32:12:34:56 on en0 ifscope [ethernet]'),
    ).toEqual([
      {
        ipAddress: '192.168.1.60',
        macAddress: 'dc:a6:32:12:34:56',
      },
    ])
  })

  it('parses linux ip neighbour style output', () => {
    expect(
      parseArpOutput('192.168.1.88 dev wlan0 lladdr 8c:aa:b5:01:02:03 REACHABLE'),
    ).toEqual([
      {
        ipAddress: '192.168.1.88',
        macAddress: '8c:aa:b5:01:02:03',
      },
    ])
  })

  it('ignores non-device neighbour entries', () => {
    expect(
      parseArpOutput([
        '? (224.0.0.251) at 01:00:5e:00:00:fb on en0 ifscope permanent [ethernet]',
        '? (169.254.10.5) at 00:11:22:33:44:55 on en0 ifscope [ethernet]',
        '? (127.0.0.1) at 00:00:00:00:00:00 on lo0 permanent [ethernet]',
      ].join('\n')),
    ).toEqual([])
  })

  it('ignores incomplete active-scan arp entries', () => {
    expect(
      parseArpOutput('? (192.168.7.99) at (incomplete) on en0 ifscope [ethernet]'),
    ).toEqual([])
  })
})

describe('parseRouterClientsJson', () => {
  it('parses a router client table export', () => {
    expect(
      parseRouterClientsJson(JSON.stringify({
        clients: [
          {
            ip: '192.168.1.31',
            mac: 'EC:62:60:88:80:84',
            hostname: 'shelly-plus-1',
            vendor: 'Shelly',
            model: 'SPSW-202PE16EU',
            status: 'connected',
          },
        ],
      })),
    ).toEqual([
      {
        ipAddress: '192.168.1.31',
        macAddress: 'ec:62:60:88:80:84',
        hostname: 'shelly-plus-1',
        vendor: 'Shelly',
        model: 'SPSW-202PE16EU',
        protocol: 'unknown',
        confidence: 0.45,
        status: 'online',
        reason: 'Router/client table reported this device on the site network.',
      },
    ])
  })

  it('accepts array exports and common DHCP lease field names', () => {
    expect(
      parseRouterClientsJson(JSON.stringify([
        {
          address: '192.168.1.88',
          hwaddr: '8c:aa:b5:01:02:03',
          name: 'esp8266-temp',
          manufacturer: 'Espressif',
        },
      ])),
    ).toEqual([
      expect.objectContaining({
        ipAddress: '192.168.1.88',
        macAddress: '8c:aa:b5:01:02:03',
        hostname: 'esp8266-temp',
        vendor: 'Espressif',
        status: 'unknown',
      }),
    ])
  })

  it('ignores malformed and non-useful router client entries', () => {
    expect(
      parseRouterClientsJson(JSON.stringify({
        clients: [
          { ip: 'not-an-ip' },
          { ip: '224.0.0.1', mac: '01:00:5e:00:00:01' },
          { name: 'missing-ip' },
        ],
      })),
    ).toEqual([])
  })
})

describe('network discovery zones', () => {
  it('parses configured site network zones', () => {
    expect(
      parseNetworkZones(JSON.stringify({
        zones: [
          {
            id: 'main-lan',
            name: 'Main LAN',
            cidr: '192.168.7.0/24',
            role: 'primary',
          },
          {
            id: 'camera-vlan',
            name: 'Camera VLAN',
            cidr: '192.168.20.0/24',
            role: 'camera',
            seedIps: ['192.168.20.40', 'not-an-ip', '224.0.0.1'],
          },
        ],
      })),
    ).toEqual([
      {
        id: 'main-lan',
        name: 'Main LAN',
        cidr: '192.168.7.0/24',
        seedIps: [],
        role: 'primary',
      },
      {
        id: 'camera-vlan',
        name: 'Camera VLAN',
        cidr: '192.168.20.0/24',
        seedIps: ['192.168.20.40'],
        role: 'camera',
      },
    ])
  })

  it('matches IPv4 addresses against CIDR zones', () => {
    expect(ipInCidr('192.168.20.40', '192.168.20.0/24')).toBe(true)
    expect(ipInCidr('192.168.21.40', '192.168.20.0/24')).toBe(false)
    expect(ipInCidr('192.168.7.31', '192.168.0.0/16')).toBe(true)
    expect(ipInCidr('192.168.7.31', 'not-a-cidr')).toBe(false)
  })

  it('keeps scan candidates scoped to configured zones', () => {
    const zones = parseNetworkZones(JSON.stringify({
      zones: [
        {
          id: 'main-lan',
          name: 'Main LAN',
          cidr: '192.168.1.0/24',
          seedIps: ['192.168.20.40'],
        },
      ],
    }))

    expect(candidateBelongsToConfiguredZone({ ipAddress: '192.168.1.31' }, zones)).toBe(true)
    expect(candidateBelongsToConfiguredZone({ ipAddress: '192.168.20.40' }, zones)).toBe(true)
    expect(candidateBelongsToConfiguredZone({ ipAddress: '172.17.0.3' }, zones)).toBe(false)
  })

  it('expands only installer-safe CIDR ranges for active scan', () => {
    expect(ipsInCidr('192.168.7.0/30')).toEqual(['192.168.7.1', '192.168.7.2'])
    expect(ipsInCidr('192.168.7.0/24', 3)).toEqual([
      '192.168.7.1',
      '192.168.7.2',
      '192.168.7.3',
    ])
    expect(ipsInCidr('192.168.0.0/16')).toEqual([])
    expect(ipsInCidr('not-a-cidr')).toEqual([])
  })
})
