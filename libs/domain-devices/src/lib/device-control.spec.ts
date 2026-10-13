import {
  deviceControlState,
  parseDeviceControlBinding,
  privateShellyBaseUrl,
} from './device-control';

const mqtt = {
  kind: 'shelly-mqtt',
  enabled: true,
  physicalId: 'shellyplus2pm-001122334455',
  channel: 1,
  topic: 'home/relay/rpc',
} as const;
const device = {
  trustStatus: 'approved',
  capabilities: [{ actions: ['turn_on', 'turn_off'] }],
  adapter: { driver: 'shelly-rpc', target: mqtt.physicalId },
  metadata: { physicalId: mqtt.physicalId, channel: 1, component: 'switch:1' },
};

describe('explicit device control contract', () => {
  it('keeps an exact MQTT route and never supplies a missing channel or topic', () => {
    expect(parseDeviceControlBinding(mqtt)).toEqual(mqtt);
    expect(parseDeviceControlBinding(null)).toBeNull();
    expect(parseDeviceControlBinding(undefined)).toBeNull();
  });
  it('normalizes HTTP origins and keeps only a server-side credential reference', () => {
    expect(
      parseDeviceControlBinding({
        ...mqtt,
        kind: 'shelly-http',
        baseUrl: 'http://192.168.7.15/',
        credentialRef: 'kitchen',
        password: 'do-not-return',
      }),
    ).toEqual({
      kind: 'shelly-http',
      enabled: true,
      physicalId: mqtt.physicalId,
      channel: 1,
      baseUrl: 'http://192.168.7.15',
      credentialRef: 'kitchen',
    });
    expect(privateShellyBaseUrl('https://172.31.1.2:8443')).toBe(
      'https://172.31.1.2:8443',
    );
    expect(privateShellyBaseUrl('http://10.1.2.3')).toBe('http://10.1.2.3');
  });
  it.each([
    false,
    [],
    'mqtt',
    { ...mqtt, kind: 'other' },
    { ...mqtt, enabled: undefined },
    { ...mqtt, enabled: 'true' },
    { ...mqtt, physicalId: '' },
    { ...mqtt, physicalId: 'a/b' },
    ...[undefined, null, '1', -1, 1.5, 32, Infinity].map((channel) => ({
      ...mqtt,
      channel,
    })),
    ...[
      '',
      '#',
      'x/+/rpc',
      ' x/rpc',
      'x\n/rpc',
      'x/command',
      'x'.repeat(600),
    ].map((topic) => ({ ...mqtt, topic })),
  ])('rejects incomplete or unsafe MQTT bindings: %j', (value) => {
    expect(() => parseDeviceControlBinding(value)).toThrow();
  });
  it.each([
    'bad',
    'http://127.0.0.1',
    'http://169.254.169.254',
    'http://8.8.8.8',
    'http://172.32.0.1',
    'http://localhost',
    'http://shelly.local',
    'http://[::1]',
    'ftp://192.168.7.15',
    'http://admin:pw@192.168.7.15',
    'http://192.168.7.15/rpc',
    'http://192.168.7.15?x=1',
    'http://192.168.7.15/#x',
    123,
    null,
  ])('rejects non-LAN or ambiguous HTTP destinations: %j', (value) => {
    expect(() => privateShellyBaseUrl(value)).toThrow();
  });
  it.each(['', 'secret/password', 1])(
    'rejects invalid credential references: %j',
    (credentialRef) => {
      expect(() =>
        parseDeviceControlBinding({
          ...mqtt,
          kind: 'shelly-http',
          baseUrl: 'http://192.168.7.15',
          credentialRef,
        }),
      ).toThrow();
    },
  );
  it('requires approval, a switching capability, an exact identity/channel and separate permission', () => {
    expect(deviceControlState(device, null).status).toBe('needs-setup');
    expect(
      deviceControlState({ ...device, trustStatus: 'discovered' }, mqtt).status,
    ).toBe('unapproved');
    expect(
      deviceControlState(
        { ...device, capabilities: [{ actions: ['read'] }] },
        mqtt,
      ).status,
    ).toBe('read-only');
    expect(deviceControlState(device, { ...mqtt, channel: 0 }).status).toBe(
      'needs-setup',
    );
    expect(
      deviceControlState(device, { ...mqtt, physicalId: 'another' }).status,
    ).toBe('needs-setup');
    expect(
      deviceControlState(
        { ...device, metadata: { ...device.metadata, component: 'em1:1' } },
        mqtt,
      ).status,
    ).toBe('needs-setup');
    expect(deviceControlState(device, { ...mqtt, enabled: false }).status).toBe(
      'disabled',
    );
    expect(deviceControlState(device, mqtt).status).toBe('ready');
  });
  it('does not send Shelly commands through the generic site-bus format', () => {
    const binding = parseDeviceControlBinding({
      kind: 'generic-mqtt',
      enabled: true,
      topic: 'site/light/command',
    })!;
    expect(deviceControlState(device, binding).status).toBe('needs-setup');
    expect(
      deviceControlState(
        { ...device, adapter: { driver: 'native-mqtt' } },
        binding,
      ).status,
    ).toBe('ready');
    expect(
      deviceControlState(
        { ...device, adapter: { driver: 'native-mqtt' } },
        mqtt,
      ).status,
    ).toBe('needs-setup');
  });
});
