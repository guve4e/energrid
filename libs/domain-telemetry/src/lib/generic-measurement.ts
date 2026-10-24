export type MeasurementQuality = 'measured' | 'invalid';

/** Canonical units are intentionally explicit. Add new metric/unit pairs in code. */
export interface MeasurementDefinition {
  metric: string;
  unit: string;
  minimum?: number;
  maximum?: number;
}

export const CORE_MEASUREMENT_DEFINITIONS: readonly MeasurementDefinition[] = [
  { metric: 'temperature', unit: 'Cel', minimum: -273.15 },
  { metric: 'humidity', unit: '%RH', minimum: 0, maximum: 100 },
  { metric: 'pressure', unit: 'hPa', minimum: 0 },
  { metric: 'power', unit: 'W' },
];

export interface GenericMeasurement {
  schemaVersion: 1;
  tenantId: string;
  siteId: string;
  /** Stable enrolled logical identity; never an address such as an IP. */
  deviceId: string;
  /** Optional associated physical inventory identity. */
  physicalDeviceId: string | null;
  componentId: string;
  channel: string;
  metric: string;
  unit: string;
  value: number | null;
  quality: MeasurementQuality;
  source: string;
  /** Safe evidence/profile reference; raw payloads and credentials do not belong here. */
  provenance: string;
  sampleId: string;
  observedAt: string;
  receivedAt: string;
}

export type GenericMeasurementInput = Omit<GenericMeasurement, 'schemaVersion'> & {
  schemaVersion?: 1;
};

const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,160}$/;
const METRIC = /^[a-z][a-z0-9_]{0,63}$/;
const UNIT = /^[A-Za-z%][A-Za-z0-9%._-]{0,31}$/;

export function canonicalUtcInstant(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    throw new Error(`${name} must be a valid UTC ISO timestamp`);
  }
  return new Date(value).toISOString();
}

/**
 * Validate a numeric measurement against an application-owned metric registry.
 * Unknown metric/unit pairs are rejected until a trusted code extension adds a definition.
 */
export function validateGenericMeasurement(
  input: unknown,
  definitions: readonly MeasurementDefinition[] = CORE_MEASUREMENT_DEFINITIONS,
): GenericMeasurement {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Expected a generic measurement');
  }
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
    throw new Error('Unsupported generic measurement schema version');
  }

  const requiredIdentifiers = [
    'tenantId', 'siteId', 'deviceId', 'componentId', 'channel',
    'source', 'provenance', 'sampleId',
  ] as const;
  for (const key of requiredIdentifiers) {
    if (typeof value[key] !== 'string' || !IDENTIFIER.test(value[key] as string)) {
      throw new Error(`Invalid measurement ${key}`);
    }
  }
  if (value.physicalDeviceId !== null &&
      (typeof value.physicalDeviceId !== 'string' || !IDENTIFIER.test(value.physicalDeviceId))) {
    throw new Error('Invalid measurement physicalDeviceId');
  }
  if (typeof value.metric !== 'string' || !METRIC.test(value.metric)) {
    throw new Error('Invalid measurement metric');
  }
  if (typeof value.unit !== 'string' || !UNIT.test(value.unit)) {
    throw new Error('Invalid measurement unit');
  }
  const definition = definitions.find(item => item.metric === value.metric && item.unit === value.unit);
  if (!definition) throw new Error('Unsupported measurement metric/unit pair');
  if (value.quality !== 'measured' && value.quality !== 'invalid') {
    throw new Error('Invalid measurement quality');
  }
  if (value.quality === 'measured') {
    if (typeof value.value !== 'number' || !Number.isFinite(value.value)) {
      throw new Error('Measured value must be finite');
    }
    if ((definition.minimum !== undefined && value.value < definition.minimum) ||
        (definition.maximum !== undefined && value.value > definition.maximum)) {
      throw new Error('Measurement value is outside the metric range');
    }
  } else if (value.value !== null) {
    throw new Error('Invalid measurements must not contain a numeric value');
  }

  const observedAt = canonicalUtcInstant(value.observedAt, 'observedAt');
  const receivedAt = canonicalUtcInstant(value.receivedAt, 'receivedAt');
  if (Date.parse(observedAt) > Date.parse(receivedAt) + 300_000) {
    throw new Error('Measurement observedAt is too far in the future');
  }

  return {
    schemaVersion: 1,
    tenantId: value.tenantId as string,
    siteId: value.siteId as string,
    deviceId: value.deviceId as string,
    physicalDeviceId: value.physicalDeviceId as string | null,
    componentId: value.componentId as string,
    channel: value.channel as string,
    metric: value.metric,
    unit: value.unit,
    value: value.value as number | null,
    quality: value.quality,
    source: value.source as string,
    provenance: value.provenance as string,
    sampleId: value.sampleId as string,
    observedAt,
    receivedAt,
  };
}

/** Additive schema evolution: future approved metrics require a trusted code definition, not a DB enum migration. */
export function extendMeasurementDefinitions(
  additions: readonly MeasurementDefinition[],
): readonly MeasurementDefinition[] {
  const definitions = [...CORE_MEASUREMENT_DEFINITIONS];
  for (const item of additions) {
    if (!METRIC.test(item.metric) || !UNIT.test(item.unit) ||
        (item.minimum !== undefined && !Number.isFinite(item.minimum)) ||
        (item.maximum !== undefined && !Number.isFinite(item.maximum)) ||
        (item.minimum !== undefined && item.maximum !== undefined && item.minimum > item.maximum) ||
        definitions.some(existing => existing.metric === item.metric)) {
      throw new Error('Invalid or duplicate measurement definition');
    }
    definitions.push({ ...item });
  }
  return definitions;
}
