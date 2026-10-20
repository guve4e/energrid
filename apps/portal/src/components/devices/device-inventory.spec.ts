import { describe, expect, it } from 'vitest';
import {
  filterInventoryDevices,
  isExampleDevice,
  needsControlSetup,
  inventoryConnectionStatus,
  type InventoryDevice,
  type InventoryFilters,
} from './device-inventory';
import { matchNetworkDevice, hasVerifiedEnrolledNetworkIdentity } from './device-network';

const relay: InventoryDevice = {
  id: 'shellyplus1-aabbccddeeff:switch:1',
  displayName: 'Kitchen relay',
  kind: 'physical',
  trustStatus: 'approved',
  zoneId: 'kitchen',
  zoneName: 'Kitchen',
  capabilities: [{ kind: 'switch', actions: ['turn_on', 'turn_off'] }],
  adapter: { protocol: 'mqtt', driver: 'shelly-discovered', configured: true },
  metadata: {
    physicalId: 'shellyplus1-aabbccddeeff',
    mqttCommandTopic: 'kitchen/lights/rpc',
  },
  control: { status: 'needs-setup', binding: null, reason: 'No route' },
  state: { status: 'online' },
};
const filters: InventoryFilters = {
  approval: 'approved',
  source: 'site',
  search: '',
  capability: 'all',
  zone: 'all',
  status: 'all',
};
const pending = { ...relay, id: 'pending', trustStatus: 'discovered' };
const example = { ...relay, id: 'example', metadata: { simulated: true } };
const ready = {
  ...relay,
  id: 'ready',
  control: { status: 'ready' as const, binding: null, reason: 'Configured' },
};
describe('inventory filtering', () => {
  it('does not label a device offline without an observation', () => {
    const unknown = { ...relay, state: { status: 'offline', observedAt: null } };
    expect(inventoryConnectionStatus(unknown)).toBe('unknown');
    expect(filterInventoryDevices([unknown], { ...filters, status: 'offline' })).toEqual([]);
    expect(inventoryConnectionStatus({ state: { status: 'offline', observedAt: '2026-10-13T08:00:00Z' } })).toBe('offline');
  });
  it('keeps pending, blocked, and examples out of the default approved site view', () => {
    expect(
      filterInventoryDevices(
        [
          relay,
          pending,
          example,
          { ...relay, id: 'blocked', trustStatus: 'blocked' },
        ],
        filters,
      ),
    ).toEqual([relay]);
  });
  it('can review pending devices without treating them as controllable', () => {
    expect(
      filterInventoryDevices([relay, pending], {
        ...filters,
        approval: 'discovered',
      }),
    ).toEqual([pending]);
    expect(
      filterInventoryDevices([pending], {
        ...filters,
        approval: 'discovered',
        status: 'controllable',
      }),
    ).toEqual([]);
  });
  it('shows a retired device as a pending discovery candidate and keeps it out of active inventory', () => {
    const retiredCandidate = {
      ...pending,
      id: 'temp-kitchen',
      metadata: { previouslyEnrolledRetired: true },
    };
    expect(filterInventoryDevices([retiredCandidate], {
      ...filters,
      approval: 'discovered',
    })).toEqual([retiredCandidate]);
    expect(filterInventoryDevices([retiredCandidate], filters)).toEqual([]);
  });
  it('separates explicit examples and simulations from site devices', () => {
    expect(isExampleDevice(example)).toBe(true);
    expect(
      isExampleDevice({
        ...relay,
        adapter: { ...relay.adapter, protocol: 'simulated' },
      }),
    ).toBe(true);
    expect(
      filterInventoryDevices([relay, example], {
        ...filters,
        source: 'examples',
      }),
    ).toEqual([example]);
    expect(
      filterInventoryDevices([relay, example], { ...filters, source: 'all' }),
    ).toHaveLength(2);
  });
  it('filters on control readiness, not just capability or readings adapter configuration', () => {
    expect(
      filterInventoryDevices([relay, ready], {
        ...filters,
        status: 'controllable',
      }),
    ).toEqual([ready]);
    expect(
      filterInventoryDevices([relay, ready], {
        ...filters,
        status: 'needs_setup',
      }),
    ).toEqual([relay]);
    expect(
      needsControlSetup({
        ...relay,
        capabilities: [{ actions: ['read'] }],
      }),
    ).toBe(false);
  });
  it.each([
    'shellyplus1-aabbccddeeff',
    ' kitchen/LIGHTS/rpc ',
    'Kitchen relay',
    'switch',
  ])('searches identity, command route, name and capability: %s', (search) => {
    expect(filterInventoryDevices([relay], { ...filters, search })).toEqual([
      relay,
    ]);
  });
  it.each([
    { capability: 'temperature' },
    { zone: 'garage' },
    { status: 'offline' },
    { search: 'unknown' },
  ])('combines filters without inventing matches: %o', (extra) => {
    expect(filterInventoryDevices([relay], { ...filters, ...extra })).toEqual(
      [],
    );
  });
  it('matches online status and sorts without mutating the input', () => {
    const input = [{ ...relay, id: 'z', zoneName: 'Utility' }, relay];
    expect(
      filterInventoryDevices(input, {
        ...filters,
        status: 'online',
        zone: 'kitchen',
        capability: 'switch',
      }).map((d) => d.id),
    ).toEqual([relay.id, 'z']);
    expect(input[0].id).toBe('z');
  });
});
describe('gateway device matching', () => {
  const network = [
    {
      id: 'shellyplus1-aabbccddeeff',
      ipAddress: '192.168.7.21',
      macAddress: 'aa:bb:cc:dd:ee:ff',
    },
  ];
  it('matches a physical channel to its exact scanned hardware identity', () => {
    expect(matchNetworkDevice(relay, network)).toEqual(network[0]);
  });
  it('matches padded MAC addresses, never a partial device name', () => {
    const device = {
      ...relay,
      id: 'arbitrary',
      metadata: { physicalId: 'shellyplus1-001122334455' },
    };
    expect(
      matchNetworkDevice(device, [
        {
          id: 'other',
          ipAddress: '192.168.7.22',
          macAddress: '0:11:22:33:44:55',
        },
      ])?.id,
    ).toBe('other');
    expect(
      matchNetworkDevice(
        { ...device, metadata: { physicalId: 'shellyplus1' } },
        network,
      ),
    ).toBeNull();
  });
  it('does not match shared model or app names', () => {
    expect(
      matchNetworkDevice({ ...relay, id: 'Plus1', metadata: {} }, [
        { ...network[0], model: 'Plus1', app: 'Plus1' },
      ]),
    ).toBeNull();
  });
  it('handles exact hostnames and missing network matches', () => {
    expect(
      matchNetworkDevice(
        {
          ...relay,
          metadata: {},
          adapter: { ...relay.adapter, target: 'Kitchen-Shelly' },
        },
        [{ ...network[0], hostname: 'kitchen-shelly' }],
      )?.id,
    ).toBe(network[0].id);
    expect(matchNetworkDevice(relay, [])).toBeNull();
  });
});

describe('verified network enrollment identity', () => {
  const enrolledShelly = {
    ...relay,
    metadata: {
      physicalId: 'shellyplus1-aabbccddeeff',
    },
  };

  const networkDevice = {
    id: 'network-device',
    ipAddress: '192.168.7.21',
    macAddress: 'aa:bb:cc:dd:ee:ff',
  };

  it('matches a complete hardware MAC', () => {
    expect(
      hasVerifiedEnrolledNetworkIdentity(
        networkDevice,
        [enrolledShelly],
      ),
    ).toBe(true);
  });

  it('does not mistake a shared IP for device identity', () => {
    expect(
      hasVerifiedEnrolledNetworkIdentity(
        {
          ...networkDevice,
          macAddress: '11:22:33:44:55:66',
        },
        [enrolledShelly],
      ),
    ).toBe(false);
  });

  it('does not claim identity without MAC evidence', () => {
    expect(
      hasVerifiedEnrolledNetworkIdentity(
        {
          id: 'ESP-3254B7',
          ipAddress: '192.168.1.133',
        },
        [enrolledShelly],
      ),
    ).toBe(false);
  });

  it('does not label an un-enrolled device', () => {
    expect(
      hasVerifiedEnrolledNetworkIdentity(
        networkDevice,
        [],
      ),
    ).toBe(false);
  });
});
