export type ElectricalMetric =
  | 'power'
  | 'energy_import_total'
  | 'energy_export_total';
export type TimestampBasis = 'device-observed' | 'collector-received';

export interface ElectricalReading {
  schemaVersion: 1;
  tenantId: string;
  siteId: string;
  deviceId: string;
  channel: string;
  metric: ElectricalMetric;
  value: number | null;
  unit: 'W' | 'kWh';
  quality: 'measured' | 'invalid';
  observedAt: string;
  receivedAt: string;
  timestampBasis: TimestampBasis;
  source: string;
}

export function utcInstant(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    throw new Error('Expected a UTC ISO timestamp');
  }
  return new Date(value).toISOString();
}

export function readingIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(value))
    throw new Error('Invalid reading identifier');
  return value;
}

/** Runtime contract, also used by storage: TypeScript types alone do not validate bus messages. */
export function validateElectricalReading(input: unknown): ElectricalReading {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Expected an electrical reading');
  const r = input as Record<string, unknown>;
  if (r.schemaVersion !== 1)
    throw new Error('Unsupported reading schema version');
  if (
    !['power', 'energy_import_total', 'energy_export_total'].includes(
      String(r.metric),
    )
  )
    throw new Error('Unsupported electrical metric');
  const metric = r.metric as ElectricalMetric;
  if (r.unit !== (metric === 'power' ? 'W' : 'kWh'))
    throw new Error('Metric and canonical unit do not match');
  if (
    !(r.quality === 'invalid' && r.value === null) &&
    !(
      r.quality === 'measured' &&
      typeof r.value === 'number' &&
      Number.isFinite(r.value) &&
      (metric === 'power' || r.value >= 0)
    )
  )
    throw new Error('Invalid reading value or quality');
  if (
    r.timestampBasis !== 'device-observed' &&
    r.timestampBasis !== 'collector-received'
  )
    throw new Error('Invalid timestamp basis');
  const observedAt = utcInstant(r.observedAt);
  const receivedAt = utcInstant(r.receivedAt);
  if (Date.parse(observedAt) > Date.parse(receivedAt) + 300_000)
    throw new Error('Reading timestamp is too far in the future');
  return {
    schemaVersion: 1,
    tenantId: readingIdentifier(r.tenantId),
    siteId: readingIdentifier(r.siteId),
    deviceId: readingIdentifier(r.deviceId),
    channel: readingIdentifier(r.channel),
    metric,
    value: r.value as number | null,
    unit: r.unit as 'W' | 'kWh',
    quality: r.quality as ElectricalReading['quality'],
    observedAt,
    receivedAt,
    timestampBasis: r.timestampBasis,
    source: readingIdentifier(r.source),
  };
}

export interface ElectricalHour {
  hour: string;
  sampleCount: number;
  invalidCount: number;
  minimum: number | null;
  maximum: number | null;
  sampleMean: number | null;
  firstValue: number | null;
  lastValue: number | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  sources: string[];
  timestampBases: TimestampBasis[];
  counterResets: number;
  estimatedImportKwh: number | null;
  estimatedExportKwh: number | null;
  coveredSeconds: number;
}

/** UTC buckets preserve signed power. Cumulative counters are never summed. */
export function summarizeElectricalHour(
  readings: readonly ElectricalReading[],
  hour: string,
): ElectricalHour {
  const from = Date.parse(utcInstant(hour)),
    to = from + 3_600_000;
  if (from % 3_600_000 !== 0) throw new Error('Expected a UTC hour boundary');
  const sorted = [...readings].sort(
    (a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt),
  );
  const key = (r: ElectricalReading) =>
    [r.tenantId, r.siteId, r.deviceId, r.channel, r.metric].join('/');
  if (sorted.some((r) => key(r) !== key(sorted[0])))
    throw new Error('Cannot summarize mixed measurement streams');
  const inside = sorted.filter(
    (r) => Date.parse(r.observedAt) >= from && Date.parse(r.observedAt) < to,
  );
  const valid = inside.filter(
    (r) => r.quality === 'measured' && r.value !== null,
  );
  const values = valid.map((r) => r.value!);
  const result: ElectricalHour = {
    hour: new Date(from).toISOString(),
    sampleCount: inside.length,
    invalidCount: inside.length - valid.length,
    minimum: values.length ? values.reduce((a, b) => Math.min(a, b)) : null,
    maximum: values.length ? values.reduce((a, b) => Math.max(a, b)) : null,
    sampleMean: values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : null,
    firstValue: values[0] ?? null,
    lastValue: values.at(-1) ?? null,
    firstObservedAt: valid[0]?.observedAt ?? null,
    lastObservedAt: valid.at(-1)?.observedAt ?? null,
    sources: [...new Set(sorted.map((r) => r.source))].sort(),
    timestampBases: [...new Set(sorted.map((r) => r.timestampBasis))].sort(),
    counterResets: 0,
    estimatedImportKwh: null,
    estimatedExportKwh: null,
    coveredSeconds: 0,
  };
  let importWattSeconds = 0,
    exportWattSeconds = 0;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1],
      b = sorted[i];
    if (
      a.value === null ||
      b.value === null ||
      a.quality !== 'measured' ||
      b.quality !== 'measured'
    )
      continue;
    const start = Date.parse(a.observedAt),
      end = Date.parse(b.observedAt);
    if (a.metric !== 'power') {
      if (end >= from && end < to && b.value < a.value) result.counterResets++;
      continue;
    }
    if (end <= start || end - start > 300_000) continue;
    const seconds =
      Math.max(0, Math.min(to, end) - Math.max(from, start)) / 1000;
    result.coveredSeconds += seconds;
    importWattSeconds += Math.max(0, a.value) * seconds;
    exportWattSeconds += Math.max(0, -a.value) * seconds;
  }
  if (result.coveredSeconds > 0) {
    result.estimatedImportKwh = importWattSeconds / 3_600_000;
    result.estimatedExportKwh = exportWattSeconds / 3_600_000;
  }
  return result;
}
