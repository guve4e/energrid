import {
  snapshotId,
  type DeviceEvidenceSnapshot,
} from './device-evidence';

import {
  validateObservationProfileProposal,
  type CapturedMqttSample,
} from './observation-profile-proposal';

describe('AI observation profile proposal validation', () => {
  const snapshot: DeviceEvidenceSnapshot = {
    schemaVersion: 1,
    deviceId: 'temp-kitchen',
    createdAt: '2026-10-18T12:00:00.000Z',
    evidence: [
      {
        id: 'mqtt-evidence-1',
        source: 'mqtt',
        attribute: 'captured-message',
        value: 'devices/temp-kitchen/data',
        observedAt: '2026-10-18T12:00:00.000Z',
        confidence: 'observed',
      },
    ],
  };

  const samples: CapturedMqttSample[] = [
    {
      topic: 'devices/temp-kitchen/data',
      evidenceId: 'mqtt-evidence-1',
      payload: {
        temperature: 25.3,
        humidity: 40.4,
        timestamp: 92671135,
      },
    },
  ];

  function proposal() {
    return {
      schemaVersion: 1,
      deviceId: snapshot.deviceId,
      snapshotId: snapshotId(snapshot),
      status: 'proposed',
      requiresApproval: true,
      protocol: 'mqtt',
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
      supportingEvidenceIds: ['mqtt-evidence-1'],
    };
  }

  it('accepts a supported proposal for replay', () => {
    const result = validateObservationProfileProposal(
      proposal(),
      snapshot,
      samples,
    );

    expect(result.status).toBe('proposed');
    expect(result.requiresApproval).toBe(true);
    expect(result.fields.temperature.rawKey).toBe('temperature');
  });

  it('rejects fabricated evidence references', () => {
    const input = proposal();

    input.supportingEvidenceIds = ['fabricated-id'];

    expect(() =>
      validateObservationProfileProposal(input, snapshot, samples),
    ).toThrow();
  });

  it('rejects a fabricated payload field', () => {
    const input = proposal();

    input.fields.temperature.rawKey = 'imaginary_temperature';

    expect(() =>
      validateObservationProfileProposal(input, snapshot, samples),
    ).toThrow();
  });

  it('rejects attempted preapproval', () => {
    const input = {
      ...proposal(),
      status: 'approved',
    };

    expect(() =>
      validateObservationProfileProposal(input, snapshot, samples),
    ).toThrow();
  });

  it('rejects MQTT topic wildcards', () => {
    const input = {
      ...proposal(),
      selector: 'devices/+/data',
    };

    expect(() =>
      validateObservationProfileProposal(input, snapshot, samples),
    ).toThrow();
  });

  it('rejects proposals based only on network scan evidence', () => {
    const networkSnapshot: DeviceEvidenceSnapshot = {
      ...snapshot,
      evidence: [
        {
          ...snapshot.evidence[0],
          source: 'network_scan',
        },
      ],
    };

    const input = {
      ...proposal(),
      snapshotId: snapshotId(networkSnapshot),
    };

    expect(() =>
      validateObservationProfileProposal(
        input,
        networkSnapshot,
        samples,
      ),
    ).toThrow();
  });
});
