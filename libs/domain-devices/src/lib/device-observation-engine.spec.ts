import {
  processDeviceObservation as processAuthorizedObservation,
  observationFreshness,
  type DeviceObservationState,
  type IncomingDeviceObservation,
  type ObservationAuthorityPolicy,
} from './device-observation-engine';

const garagePolicy: ObservationAuthorityPolicy = {
  deviceId: 'esp8266-garage',
  allowedSourcesByField: {
    temperature: ['mqtt'],
    humidity: ['mqtt'],
  },
};

// Explicit test fixture for the original observation tests.
function processDeviceObservation(
  current: DeviceObservationState | null,
  observation: IncomingDeviceObservation,
  policy: ObservationAuthorityPolicy = garagePolicy,
) {
  return processAuthorizedObservation(current, observation, policy);
}

describe('Energrid Observation Engine V1', () => {
  const base = {
    deviceId: 'esp8266-garage',
    sourceId: 'mqtt',
    receivedAt: '2026-10-18T11:00:00.000Z',
  };

  it('accepts a first observation', () => {
    const result = processDeviceObservation(null, {
      ...base,
      values: {
        temperature: 25,
        humidity: 41.4,
      },
    });

    expect(result.accepted).toBe(true);
    expect(result.updatedKeys).toEqual([
      'temperature',
      'humidity',
    ]);
    expect(result.state?.fields.temperature.value).toBe(25);
  });

  it('rejects an older measurement', () => {
    const first = processDeviceObservation(null, {
      ...base,
      receivedAt: '2026-10-18T11:05:00.000Z',
      values: { temperature: 25 },
    });

    const second = processDeviceObservation(first.state, {
      ...base,
      receivedAt: '2026-10-18T11:00:00.000Z',
      values: { temperature: 23.6 },
    });

    expect(second.accepted).toBe(false);
    expect(second.reason).toBe('stale_observation');
    expect(second.state?.fields.temperature.value).toBe(25);
  });

  it('preserves humidity when only temperature updates', () => {
    const first = processDeviceObservation(null, {
      ...base,
      values: {
        temperature: 23.6,
        humidity: 48,
      },
    });

    const second = processDeviceObservation(first.state, {
      ...base,
      receivedAt: '2026-10-18T11:05:00.000Z',
      values: { temperature: 25 },
    });

    expect(second.state?.fields.temperature.value).toBe(25);
    expect(second.state?.fields.humidity.value).toBe(48);
  });

  it('tracks freshness independently', () => {
    const result = processDeviceObservation(null, {
      ...base,
      values: { temperature: 25 },
    });

    const field = result.state!.fields.temperature;

    expect(
      observationFreshness(
        field,
        '2026-10-18T11:00:30.000Z',
        60_000,
      ),
    ).toBe('fresh');

    expect(
      observationFreshness(
        field,
        '2026-10-18T11:05:00.000Z',
        60_000,
      ),
    ).toBe('stale');
  });

  it('rejects invalid readings', () => {
    const result = processDeviceObservation(null, {
      ...base,
      values: { temperature: Number.NaN },
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('invalid_observation');
  });

  it('rejects future device measurement timestamps', () => {
    const result = processDeviceObservation(null, {
      ...base,
      measuredAt: '2026-10-18T12:00:00.000Z',
      values: { temperature: 25 },
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('invalid_observation');
  });

  it('handles mixed fresh and stale fields independently', () => {
    const first = processDeviceObservation(null, {
      ...base,
      values: { temperature: 23, humidity: 48 },
    });

    const second = processDeviceObservation(first.state, {
      ...base,
      receivedAt: '2026-10-18T11:10:00.000Z',
      values: { temperature: 25 },
    });

    const third = processDeviceObservation(second.state, {
      ...base,
      receivedAt: '2026-10-18T11:05:00.000Z',
      values: { temperature: 24, humidity: 45 },
    });

    expect(third.updatedKeys).toEqual(['humidity']);
    expect(third.ignoredKeys).toEqual(['temperature']);
    expect(third.state?.fields.temperature.value).toBe(25);
    expect(third.state?.fields.humidity.value).toBe(45);
  });
});


describe('Observation source authority', () => {
  const policy: ObservationAuthorityPolicy = {
    deviceId: 'esp8266-garage',
    allowedSourcesByField: {
      temperature: ['mqtt-esp8266'],
      humidity: ['mqtt-esp8266'],
    },
  };

  it('rejects an unapproved source', () => {
    const trusted = processDeviceObservation(null, {
      deviceId: 'esp8266-garage',
      sourceId: 'mqtt-esp8266',
      receivedAt: '2026-10-18T11:00:00.000Z',
      values: { temperature: 25 },
    }, policy);

    const untrusted = processDeviceObservation(trusted.state, {
      deviceId: 'esp8266-garage',
      sourceId: 'legacy-framework',
      receivedAt: '2026-10-18T11:05:00.000Z',
      values: { temperature: 23.6 },
    }, policy);

    expect(untrusted.accepted).toBe(false);
    expect(untrusted.reason).toBe('source_not_authorized');
    expect(untrusted.state?.fields.temperature.value).toBe(25);
  });

  it('protects multiple fields from unauthorized updates', () => {
    const trusted = processDeviceObservation(null, {
      deviceId: 'esp8266-garage',
      sourceId: 'mqtt-esp8266',
      receivedAt: '2026-10-18T11:00:00.000Z',
      values: {
        temperature: 25,
        humidity: 41.4,
      },
    }, policy);

    const untrusted = processDeviceObservation(trusted.state, {
      deviceId: 'esp8266-garage',
      sourceId: 'legacy-framework',
      receivedAt: '2026-10-18T11:10:00.000Z',
      values: {
        temperature: 23.6,
        humidity: 48,
      },
    }, policy);

    expect(untrusted.accepted).toBe(false);
    expect(untrusted.state?.fields.temperature.value).toBe(25);
    expect(untrusted.state?.fields.humidity.value).toBe(41.4);
  });

  it('supports different authorized sources per capability', () => {
    const mixedPolicy: ObservationAuthorityPolicy = {
      deviceId: 'esp8266-garage',
      allowedSourcesByField: {
        temperature: ['mqtt-esp8266'],
        humidity: ['mqtt-esp8266'],
        power: ['modbus-meter'],
      },
    };

    const temperature = processDeviceObservation(null, {
      deviceId: 'esp8266-garage',
      sourceId: 'mqtt-esp8266',
      receivedAt: '2026-10-18T11:00:00.000Z',
      values: { temperature: 25 },
    }, mixedPolicy);

    const power = processDeviceObservation(temperature.state, {
      deviceId: 'esp8266-garage',
      sourceId: 'modbus-meter',
      receivedAt: '2026-10-18T11:01:00.000Z',
      values: {
        temperature: 99,
        power: 500,
      },
    }, mixedPolicy);

    expect(power.accepted).toBe(true);
    expect(power.updatedKeys).toEqual(['power']);
    expect(power.ignoredKeys).toEqual(['temperature']);
    expect(power.state?.fields.temperature.value).toBe(25);
    expect(power.state?.fields.power.value).toBe(500);
  });

  it('rejects observations without an authority policy', () => {
    const result = processAuthorizedObservation(null, {
      deviceId: 'esp8266-garage',
      sourceId: 'mqtt-esp8266',
      receivedAt: '2026-10-18T11:00:00.000Z',
      values: { temperature: 25 },
    }, undefined as unknown as ObservationAuthorityPolicy);

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('invalid_policy');
  });

  it('rejects a policy belonging to another device', () => {
    const result = processDeviceObservation(null, {
      deviceId: 'esp8266-garage',
      sourceId: 'mqtt-esp8266',
      receivedAt: '2026-10-18T11:00:00.000Z',
      values: { temperature: 25 },
    }, {
      deviceId: 'different-device',
      allowedSourcesByField: {
        temperature: ['mqtt-esp8266'],
      },
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('invalid_policy');
  });
});
