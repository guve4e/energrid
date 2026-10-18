import {
  decodeObservationProfile,
  type ApprovedObservationBinding,
} from './device-observation-profile';

describe('Energrid Device Profile Decoder V1', () => {
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

  const context = {
    selector: 'devices/temp-kitchen/data',
    receivedAt: '2026-10-18T11:15:00.000Z',
    evidenceId: 'mqtt-evidence-123',
  };

  it('decodes the real ESP8266 payload', () => {
    const result = decodeObservationProfile(
      binding,
      context,
      {
        temperature: 25,
        humidity: 41.4,
        timestamp: 78775134,
      },
    );

    expect(result.accepted).toBe(true);

    expect(result.observation).toEqual({
      deviceId: 'esp8266-garage',
      sourceId: 'mqtt-garage-approved',
      evidenceId: 'mqtt-evidence-123',
      receivedAt: context.receivedAt,
      values: {
        temperature: 25,
        humidity: 41.4,
      },
    });

    expect(result.observation?.measuredAt).toBeUndefined();
  });

  it('does not trust identity supplied by the publisher', () => {
    const result = decodeObservationProfile(
      binding,
      context,
      {
        deviceId: 'admin-controller',
        sourceId: 'trusted-system',
        temperature: 25,
        humidity: 41.4,
      },
    );

    expect(result.observation?.deviceId).toBe('esp8266-garage');
    expect(result.observation?.sourceId).toBe('mqtt-garage-approved');
  });

  it('rejects an unrelated transport selector', () => {
    const result = decodeObservationProfile(
      binding,
      {
        ...context,
        selector: 'devices/unknown/data',
      },
      { temperature: 25 },
    );

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('selector_mismatch');
  });

  it('accepts partial valid measurements', () => {
    const result = decodeObservationProfile(
      binding,
      context,
      {
        temperature: 25,
        humidity: 'invalid',
      },
    );

    expect(result.accepted).toBe(true);
    expect(result.observation?.values).toEqual({
      temperature: 25,
    });
    expect(result.rejectedFields).toEqual(['humidity']);
  });

  it('rejects payloads without valid measurements', () => {
    const result = decodeObservationProfile(
      binding,
      context,
      {
        temperature: 'broken',
        humidity: null,
      },
    );

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('no_valid_measurements');
  });

  it('rejects invalid profile mappings', () => {
    const result = decodeObservationProfile(
      {
        ...binding,
        fields: {
          temperature: {
            rawKey: '__proto__',
            type: 'number',
          },
        },
      },
      context,
      { temperature: 25 },
    );

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('invalid_binding');
  });
});
