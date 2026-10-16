import { describe, expect, it } from 'vitest';
import { discoveredShellyAddress } from './device-network';
import type { ControlSetupDevice } from './device-control';

const physicalId = 'shellyplus1-8813bfcdc8bc';
const device: ControlSetupDevice = {
  id: `${physicalId}:switch:0`,
  trustStatus: 'approved',
  capabilities: [{ actions: ['turn_on', 'turn_off'] }],
  adapter: {
    protocol: 'mqtt',
    driver: 'shelly-discovered',
    target: physicalId,
  },
  metadata: { physicalId, channel: 0, component: 'switch:0' },
};
const network = {
  id: physicalId,
  ipAddress: '192.168.7.25',
  macAddress: '88:13:bf:cd:c8:bc',
};

describe('discovered Shelly HTTP address suggestion', () => {
  it('matches exact physical identity and normalizes the address without changing the device', () => {
    const before = JSON.stringify(device);
    expect(discoveredShellyAddress(device, [network])).toBe(
      'http://192.168.7.25',
    );
    expect(JSON.stringify(device)).toBe(before);
  });
  it('matches an exact hardware MAC even when the scanner names the device differently', () => {
    expect(
      discoveredShellyAddress(device, [{ ...network, id: 'neighbor' }]),
    ).toBe('http://192.168.7.25');
  });
  it('prefers an exact LAN match over an older metadata address', () => {
    expect(
      discoveredShellyAddress(
        {
          ...device,
          metadata: { ...device.metadata, httpBaseUrl: 'http://192.168.7.10' },
        },
        [network],
      ),
    ).toBe('http://192.168.7.25');
  });
  it('uses known HTTP metadata without requiring a fresh scan', () => {
    expect(
      discoveredShellyAddress(
        {
          ...device,
          metadata: {
            ...device.metadata,
            httpBaseUrl: 'https://192.168.7.25:8443/',
          },
        },
        [],
      ),
    ).toBe('https://192.168.7.25:8443');
  });
  it('extracts only the origin from an existing HTTP readings endpoint', () => {
    expect(
      discoveredShellyAddress(
        {
          ...device,
          adapter: {
            ...device.adapter,
            protocol: 'http',
            target: 'http://192.168.7.25/rpc/Switch.GetStatus?id=0',
          },
        },
        [],
      ),
    ).toBe('http://192.168.7.25');
  });
  it('does not confuse MQTT identity or command topics with an IP address', () => {
    expect(discoveredShellyAddress(device, [])).toBeNull();
    expect(
      discoveredShellyAddress(
        { ...device, adapter: { ...device.adapter, target: 'shelly/rpc' } },
        [],
      ),
    ).toBeNull();
  });
  it('never chooses a similar model, partial name, or another device at an old target IP', () => {
    expect(
      discoveredShellyAddress(
        { ...device, adapter: { ...device.adapter, target: '192.168.7.25' } },
        [
          {
            ...network,
            id: 'shellyplus1-other',
            macAddress: '00:11:22:33:44:55',
            hostname: 'Plus1',
          },
        ],
      ),
    ).toBeNull();
  });
  it.each([
    'http://example.com',
    'http://127.0.0.1',
    'http://169.254.169.254',
    'http://192.168.7.25/path',
    'http://admin:password@192.168.7.25',
    'invalid',
  ])('rejects unsafe metadata: %s', (httpBaseUrl) => {
    expect(
      discoveredShellyAddress(
        { ...device, metadata: { ...device.metadata, httpBaseUrl } },
        [],
      ),
    ).toBeNull();
  });
  it.each(['127.0.0.1', '169.254.169.254', 'example.com', '192.168.7.999'])(
    'does not suggest an unsafe scanned address: %s',
    (ipAddress) => {
      expect(
        discoveredShellyAddress(device, [{ ...network, ipAddress }]),
      ).toBeNull();
    },
  );
  it('does not guess among conflicting matching addresses, but tolerates duplicate observations', () => {
    expect(
      discoveredShellyAddress(device, [
        network,
        { ...network, ipAddress: '192.168.7.26' },
      ]),
    ).toBeNull();
    expect(discoveredShellyAddress(device, [network, network])).toBe(
      'http://192.168.7.25',
    );
  });
  it.each(['http://admin:password@192.168.7.25/rpc', 'not-a-url'])(
    'does not reuse a secret-bearing or invalid readings target: %s',
    (target) => {
      expect(
        discoveredShellyAddress(
          {
            ...device,
            adapter: { ...device.adapter, protocol: 'http', target },
          },
          [],
        ),
      ).toBeNull();
    },
  );
  it('requires Shelly hardware metadata, not a generic device or missing physical identity', () => {
    expect(
      discoveredShellyAddress({ ...device, metadata: {} }, [network]),
    ).toBeNull();
    expect(
      discoveredShellyAddress(
        { ...device, adapter: { ...device.adapter, driver: 'generic-mqtt' } },
        [network],
      ),
    ).toBeNull();
  });
});
