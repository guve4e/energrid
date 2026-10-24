import {
  extendMeasurementDefinitions,
  validateGenericMeasurement,
  type GenericMeasurementInput,
} from './generic-measurement';

const base = (): GenericMeasurementInput => ({
  tenantId: 'tenant-a',
  siteId: 'site-a',
  deviceId: 'device-stable-id',
  physicalDeviceId: 'physical-asset-id',
  componentId: 'dht22',
  channel: 'environment',
  metric: 'temperature',
  unit: 'Cel',
  value: 21.5,
  quality: 'measured',
  source: 'http-status-v1',
  provenance: 'binding-dht22-status',
  sampleId: 'sample-001',
  observedAt: '2026-10-23T12:00:00.000Z',
  receivedAt: '2026-10-23T12:00:01.000Z',
});

describe('generic measurement contract', () => {
  it.each([
    ['temperature', 'Cel', 20],
    ['humidity', '%RH', 50],
    ['pressure', 'hPa', 1013],
    ['power', 'W', 250],
  ])('accepts canonical %s in %s', (metric, unit, value) => {
    expect(validateGenericMeasurement({
      ...base(), metric, unit, value,
    })).toMatchObject({ schemaVersion: 1, metric, unit, value });
  });

  it.each([
    [{ unit: 'F' }, 'Unsupported measurement metric/unit pair'],
    [{ metric: 'future_metric', unit: 'u' }, 'Unsupported measurement metric/unit pair'],
    [{ value: Number.NaN }, 'Measured value must be finite'],
    [{ value: Number.POSITIVE_INFINITY }, 'Measured value must be finite'],
    [{ metric: 'humidity', unit: '%RH', value: 101 }, 'Measurement value is outside the metric range'],
    [{ metric: 'temperature', unit: 'Cel', value: -300 }, 'Measurement value is outside the metric range'],
    [{ observedAt: 'yesterday' }, 'observedAt must be a valid UTC ISO timestamp'],
    [{ receivedAt: '2026-10-23T12:00:00+02:00' }, 'receivedAt must be a valid UTC ISO timestamp'],
    [{ quality: 'invalid', value: 1 }, 'Invalid measurements must not contain a numeric value'],
  ])('rejects unsafe measurement input %j', (patch, message) => {
    expect(() => validateGenericMeasurement({ ...base(), ...patch })).toThrow(message);
  });

  it('permits a future metric after an explicit trusted code definition is added', () => {
    const definitions = extendMeasurementDefinitions([
      { metric: 'voc_index', unit: 'index', minimum: 0 },
    ]);
    expect(validateGenericMeasurement({
      ...base(), metric: 'voc_index', unit: 'index', value: 12,
    }, definitions).metric).toBe('voc_index');
    expect(() => validateGenericMeasurement({
      ...base(), metric: 'future_metric', unit: 'u',
    }, definitions)).toThrow('Unsupported measurement metric/unit pair');
  });

  it('rejects conflicting or invalid future definitions', () => {
    expect(() => extendMeasurementDefinitions([
      { metric: 'temperature', unit: 'F' },
    ])).toThrow('Invalid or duplicate measurement definition');
    expect(() => extendMeasurementDefinitions([
      { metric: 'voc_index', unit: 'index', minimum: 10, maximum: 1 },
    ])).toThrow('Invalid or duplicate measurement definition');
  });
});
