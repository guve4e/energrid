import {
  processObservationPipeline,
} from './device-observation-pipeline';

import type {
  ApprovedObservationBinding,
} from './device-observation-profile';

import type {
  ObservationAuthorityPolicy,
} from './device-observation-engine';

describe('Energrid Observation Pipeline', () => {

  const binding: ApprovedObservationBinding = {
    deviceId: 'esp8266-garage',
    sourceId: 'mqtt-garage-approved',
    selector: 'devices/temp-kitchen/data',
    fields: {
      temperature: {
        rawKey: 'temperature',
        type: 'number',
      },
      humidity: {
        rawKey: 'humidity',
        type: 'number',
      },
    },
  };

  const policy: ObservationAuthorityPolicy = {
    deviceId: 'esp8266-garage',
    allowedSourcesByField: {
      temperature: ['mqtt-garage-approved'],
      humidity: ['mqtt-garage-approved'],
    },
  };

  const context = {
    selector: 'devices/temp-kitchen/data',
    receivedAt: '2026-10-18T11:00:00.000Z',
    evidenceId: 'mqtt-message-001',
  };

  it('processes the real ESP8266 MQTT payload', () => {
    const result = processObservationPipeline({
      binding,
      policy,
      context,
      currentState: null,
      payload: {
        temperature: 25,
        humidity: 41.4,
        timestamp: 78775134,
      },
    });

    expect(result.accepted).toBe(true);

    expect(result.stage).toBe('observation');

    expect(result.state?.fields.temperature.value).toBe(25);

    expect(result.state?.fields.humidity.value).toBe(41.4);
  });

  it('rejects telemetry without approved binding', () => {
    const result = processObservationPipeline({
      binding: null,
      policy: null,
      context,
      currentState: null,
      payload: {
        temperature: 25,
      },
    });

    expect(result.accepted).toBe(false);

    expect(result.reason).toBe(
      'approved_binding_required',
    );
  });

  it('prevents MQTT payload identity spoofing', () => {
    const result = processObservationPipeline({
      binding,
      policy,
      context,
      currentState: null,
      payload: {
        deviceId: 'admin-controller',
        sourceId: 'trusted-system',
        temperature: 25,
      },
    });

    expect(result.accepted).toBe(true);

    expect(result.deviceId).toBe('esp8266-garage');
  });

  it('rejects older observations', () => {
    const first = processObservationPipeline({
      binding,
      policy,
      context: {
        ...context,
        receivedAt: '2026-10-18T11:10:00.000Z',
      },
      currentState: null,
      payload: {
        temperature: 25,
      },
    });

    const older = processObservationPipeline({
      binding,
      policy,
      context: {
        ...context,
        receivedAt: '2026-10-18T11:05:00.000Z',
      },
      currentState: first.state,
      payload: {
        temperature: 23.6,
      },
    });

    expect(older.accepted).toBe(false);

    expect(older.reason).toBe('stale_observation');

    expect(
      older.state?.fields.temperature.value,
    ).toBe(25);
  });

  it('preserves humidity during partial updates', () => {
    const first = processObservationPipeline({
      binding,
      policy,
      context,
      currentState: null,
      payload: {
        temperature: 23.6,
        humidity: 48,
      },
    });

    const second = processObservationPipeline({
      binding,
      policy,
      context: {
        ...context,
        receivedAt: '2026-10-18T11:05:00.000Z',
      },
      currentState: first.state,
      payload: {
        temperature: 25,
      },
    });

    expect(
      second.state?.fields.temperature.value,
    ).toBe(25);

    expect(
      second.state?.fields.humidity.value,
    ).toBe(48);
  });

  it('rejects an unauthorized source', () => {
    const result = processObservationPipeline({
      binding,
      policy: {
        deviceId: 'esp8266-garage',
        allowedSourcesByField: {
          temperature: ['different-source'],
          humidity: ['different-source'],
        },
      },
      context,
      currentState: null,
      payload: {
        temperature: 25,
      },
    });

    expect(result.accepted).toBe(false);

    expect(result.reason).toBe(
      'source_not_authorized',
    );
  });

  it('rejects messages on an unrelated topic', () => {
    const result = processObservationPipeline({
      binding,
      policy,
      context: {
        ...context,
        selector: 'devices/unknown/data',
      },
      currentState: null,
      payload: {
        temperature: 25,
      },
    });

    expect(result.accepted).toBe(false);

    expect(result.reason).toBe('selector_mismatch');
  });

  it('reports invalid fields without discarding valid ones', () => {
    const result = processObservationPipeline({
      binding,
      policy,
      context,
      currentState: null,
      payload: {
        temperature: 25,
        humidity: 'invalid',
      },
    });

    expect(result.accepted).toBe(true);

    expect(result.rejectedFields).toEqual(['humidity']);

    expect(
      result.state?.fields.temperature.value,
    ).toBe(25);
  });

});
