import {
  diagnoseDeviceConnection,
  type DeviceConnectionEvidence,
} from './device-diagnostics';

const checkedAt = '2026-10-13T08:00:00.000Z';
function evidence(): DeviceConnectionEvidence {
  return {
    deviceId: 'shelly:switch:0',
    checkedAt,
    transport: 'mqtt',
    controlEnabled: true,
    readingsSource: 'HTTP',
    lastTelemetryAt: null,
    identity: { status: 'observed', checkedAt, value: { matches: true } },
    relay: { status: 'observed', checkedAt, value: { on: false } },
    mqttConfig: {
      status: 'observed',
      checkedAt,
      value: {
        enabled: true,
        rpcEnabled: true,
        notificationsEnabled: true,
        topic: 'device/rpc',
        broker: 'broker:1883',
      },
    },
    mqttStatus: { status: 'observed', checkedAt, value: { connected: true } },
    expectedTopic: 'device/rpc',
    expectedBroker: 'broker:1883',
    listener: 'running',
    sharedTopic: false,
    lastCommand: null,
  };
}

describe('read-only device connection diagnosis', () => {
  it('distinguishes HTTP reachability from disabled MQTT and never calls missing readings offline', () => {
    const e = evidence();
    e.mqttConfig.value!.enabled = false;
    e.mqttStatus.value!.connected = false;
    const report = diagnoseDeviceConnection(e);
    expect(report.code).toBe('mqtt-disabled');
    expect(report.title).toContain('reachable');
    expect(report.currentRelay).toEqual({ on: false, checkedAt });
    expect(report.checks.find((c) => c.id === 'readings')?.detail).toContain(
      'do not mean offline',
    );
    expect(report.readOnly).toBe(true);
  });
  it.each([
    [
      'broker-mismatch',
      (e: DeviceConnectionEvidence) => {
        e.mqttConfig.value!.broker = 'other:1883';
      },
    ],
    [
      'topic-mismatch',
      (e: DeviceConnectionEvidence) => {
        e.mqttConfig.value!.topic = 'wrong/rpc';
      },
    ],
    [
      'rpc-disabled',
      (e: DeviceConnectionEvidence) => {
        e.mqttConfig.value!.rpcEnabled = false;
      },
    ],
    [
      'mqtt-disconnected',
      (e: DeviceConnectionEvidence) => {
        e.mqttStatus.value!.connected = false;
      },
    ],
    [
      'notifications-disabled',
      (e: DeviceConnectionEvidence) => {
        e.mqttConfig.value!.notificationsEnabled = false;
      },
    ],
    [
      'listener-unavailable',
      (e: DeviceConnectionEvidence) => {
        e.listener = 'disabled';
      },
    ],
    [
      'listener-unavailable',
      (e: DeviceConnectionEvidence) => {
        e.listener = 'stopped';
      },
    ],
    [
      'shared-topic',
      (e: DeviceConnectionEvidence) => {
        e.sharedTopic = true;
      },
    ],
    [
      'control-disabled',
      (e: DeviceConnectionEvidence) => {
        e.controlEnabled = false;
      },
    ],
    [
      'control-disabled',
      (e: DeviceConnectionEvidence) => {
        e.transport = 'none';
      },
    ],
  ])('explains %s from explicit evidence', (code, modify) => {
    const e = evidence();
    modify(e);
    expect(diagnoseDeviceConnection(e).code).toBe(code);
  });
  it('does not mistake HTTP checks for a successful switching test or confirm an old command', () => {
    const e = evidence();
    e.transport = 'http';
    e.lastCommand = {
      action: 'turn_on',
      outcome: 'timed_out',
      requestedAt: checkedAt,
      publishedAt: checkedAt,
      completedAt: checkedAt,
    };
    const before = JSON.stringify(e);
    const r = diagnoseDeviceConnection(e);
    expect(r.code).toBe('checks-passed');
    expect(r.summary).toContain('No switching command was sent');
    expect(r.lastCommand?.outcome).toBe('timed_out');
    expect(r.checks.find((c) => c.id === 'last-command')?.detail).toContain(
      'does not prove device receipt',
    );
    expect(JSON.stringify(e)).toBe(before);
  });
  it('stops interpreting configuration or relay responses from different hardware', () => {
    const e = evidence();
    e.identity.value!.matches = false;
    e.mqttConfig.value!.enabled = false;
    const r = diagnoseDeviceConnection(e);
    expect(r.code).toBe('identity-mismatch');
    expect(r.currentRelay).toBeNull();
    expect(r.checks.find((c) => c.id === 'mqtt-enabled')?.status).toBe(
      'unknown',
    );
  });
  it.each(['unavailable', 'skipped', 'auth-required'] as const)(
    'does not call an inconclusive HTTP check offline: %s',
    (status) => {
      const e = evidence();
      e.identity = { status, checkedAt };
      const r = diagnoseDeviceConnection(e);
      expect(r.code).toBe(
        status === 'auth-required' ? 'authentication-required' : 'incomplete',
      );
      expect(r.currentRelay).toBeNull();
    },
  );
  it('reports authentication required even if the public identity method answered', () => {
    const e = evidence();
    e.relay = { status: 'auth-required', checkedAt };
    expect(diagnoseDeviceConnection(e).code).toBe('authentication-required');
  });
  it.each([
    'enabled',
    'rpcEnabled',
    'notificationsEnabled',
    'topic',
    'broker',
  ] as const)(
    'does not claim a complete MQTT connection when %s is unknown',
    (key) => {
      const e = evidence();
      e.mqttConfig.value![key] = null;
      expect(diagnoseDeviceConnection(e).code).toBe('incomplete');
    },
  );
  it.each(['mqtt://BROKER:1883', 'broker'])(
    'normalizes equivalent broker endpoints: %s',
    (broker) => {
      const e = evidence();
      e.mqttConfig.value!.broker = broker;
      expect(diagnoseDeviceConnection(e).code).toBe('checks-passed');
    },
  );
  it.each([
    'http://broker',
    'mqtt://user:password@broker',
    'mqtt://broker/path',
    'broken port:xx',
  ])('never passes an invalid endpoint: %s', (broker) => {
    const e = evidence();
    e.mqttConfig.value!.broker = broker;
    expect(diagnoseDeviceConnection(e).code).toBe('incomplete');
  });
  it('preserves last telemetry and settled history as separate, timestamped evidence', () => {
    const e = evidence();
    e.lastTelemetryAt = checkedAt;
    e.lastCommand = {
      action: 'turn_off',
      outcome: 'settled',
      requestedAt: checkedAt,
      completedAt: checkedAt,
      publishedAt: null,
    };
    const r = diagnoseDeviceConnection(e);
    expect(r.checks.find((c) => c.id === 'readings')?.detail).toContain(
      checkedAt,
    );
    expect(r.checks.find((c) => c.id === 'last-command')?.status).toBe(
      'passed',
    );
    expect(r.checks.every((c) => c.checkedAt === checkedAt)).toBe(true);
  });
});
