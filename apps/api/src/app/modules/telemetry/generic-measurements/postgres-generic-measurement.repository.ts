import type { Pool } from 'pg';
import {
  CORE_MEASUREMENT_DEFINITIONS,
  type GenericMeasurement,
  type GenericMeasurementInput,
  type MeasurementDefinition,
  validateGenericMeasurement,
} from '@energrid/domain-telemetry';
import type { MeasurementHistoryPolicy } from '../telemetry.config';
import { decideMeasurementHistoryWrite } from './measurement-history-policy';

const COLUMNS = `schema_version,tenant_id,site_id,device_id,physical_device_id,
  component_id,channel,metric,unit,value,quality,source,provenance,sample_id,observed_at,received_at`;
const IDENTITY = `tenant_id=$1 AND site_id=$2 AND device_id=$3 AND component_id=$4
  AND channel=$5 AND metric=$6 AND sample_id=$7`;

export class ConflictingMeasurementSampleError extends Error {
  constructor() {
    super('Conflicting measurement for an existing sample identity');
    this.name = 'ConflictingMeasurementSampleError';
  }
}

export type MeasurementAppendResult = 'stored' | 'duplicate';
export type MeasurementHistoryAppendResult =
  | { outcome: 'stored'; reason: 'initial' | 'meaningful_change' | 'heartbeat' }
  | { outcome: 'duplicate' }
  | { outcome: 'skipped'; reason: 'below_threshold' | 'clock_not_advanced' };

/**
 * Internal PostgreSQL adapter. Keep it out of controllers and public module exports.
 * Only trusted application ingestion code may call append after installation,
 * enrollment, field/source authorization, and deterministic acceptance succeed.
 */
export class PostgresGenericMeasurementRepository {
  constructor(
    private readonly pool: Pool,
    private readonly definitions: readonly MeasurementDefinition[] = CORE_MEASUREMENT_DEFINITIONS,
  ) {}

  /**
   * Ensure the telemetry database has the parent key required by its local
   * measurement FK. Only identity keys come from the authoritative enrollment;
   * remaining non-null columns are neutral reference values, not copied data.
   * PostgreSQL's unique constraint makes concurrent calls idempotent.
   */
  async ensureEnrollmentReference(identity: {
    tenantId: string;
    siteId: string;
    deviceId: string;
  }): Promise<void> {
    if ([identity.tenantId, identity.siteId, identity.deviceId].some(value => !value?.trim())) {
      throw new Error('Enrollment reference identity is required');
    }
    await this.pool.query(
      `INSERT INTO device_inventory.enrollments (
         tenant_id,site_id,device_id,display_name,status,enrolled_at,updated_at,version
       ) VALUES ($1,$2,$3,'History enrollment reference','enrolled',now(),now(),1)
       ON CONFLICT (tenant_id,site_id,device_id) DO NOTHING`,
      [identity.tenantId, identity.siteId, identity.deviceId],
    );
  }

  async append(input: GenericMeasurementInput): Promise<MeasurementAppendResult> {
    const measurement = validateGenericMeasurement(input, this.definitions);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO telemetry.measurements (${COLUMNS})
         VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (tenant_id,site_id,device_id,component_id,channel,metric,sample_id)
         DO NOTHING RETURNING sample_id`,
        values(measurement),
      );
      if (inserted.rowCount) {
        await client.query('COMMIT');
        return 'stored';
      }

      const existing = await client.query(
        `SELECT physical_device_id,unit,value,quality,source,provenance,observed_at
         FROM telemetry.measurements WHERE ${IDENTITY}`,
        identityValues(measurement),
      );
      const row = existing.rows[0];
      if (!row || !sameSample(row, measurement)) {
        throw new ConflictingMeasurementSampleError();
      }
      await client.query('COMMIT');
      return 'duplicate';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Policy check and append share a transaction and stream lock, so restarts and concurrent polls use committed history. */
  async appendIfDue(
    input: GenericMeasurementInput,
    policy: MeasurementHistoryPolicy,
  ): Promise<MeasurementHistoryAppendResult> {
    const measurement = validateGenericMeasurement(input, this.definitions);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const stream = JSON.stringify([
        measurement.tenantId, measurement.siteId, measurement.deviceId,
        measurement.componentId, measurement.channel, measurement.metric,
      ]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [stream]);

      const existing = await client.query(
        `SELECT physical_device_id,unit,value,quality,source,provenance,observed_at
         FROM telemetry.measurements WHERE ${IDENTITY}`,
        identityValues(measurement),
      );
      if (existing.rows[0]) {
        if (!sameSample(existing.rows[0], measurement)) {
          throw new ConflictingMeasurementSampleError();
        }
        await client.query('COMMIT');
        return { outcome: 'duplicate' };
      }

      const latest = await client.query(
        `SELECT ${COLUMNS} FROM telemetry.measurements
         WHERE tenant_id=$1 AND site_id=$2 AND device_id=$3 AND component_id=$4
           AND channel=$5 AND metric=$6
         ORDER BY received_at DESC,observed_at DESC,sample_id DESC LIMIT 1`,
        [measurement.tenantId, measurement.siteId, measurement.deviceId,
          measurement.componentId, measurement.channel, measurement.metric],
      );
      const prior = latest.rows[0] ? fromRow(latest.rows[0], this.definitions) : null;
      const decision = decideMeasurementHistoryWrite(measurement, prior, policy);
      if (!decision.persist) {
        await client.query('COMMIT');
        return { outcome: 'skipped', reason: decision.reason };
      }

      const inserted = await client.query(
        `INSERT INTO telemetry.measurements (${COLUMNS})
         VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (tenant_id,site_id,device_id,component_id,channel,metric,sample_id)
         DO NOTHING RETURNING sample_id`,
        values(measurement),
      );
      if (inserted.rowCount) {
        await client.query('COMMIT');
        return { outcome: 'stored', reason: decision.reason };
      }

      const conflict = await client.query(
        `SELECT physical_device_id,unit,value,quality,source,provenance,observed_at
         FROM telemetry.measurements WHERE ${IDENTITY}`,
        identityValues(measurement),
      );
      if (!conflict.rows[0] || !sameSample(conflict.rows[0], measurement)) {
        throw new ConflictingMeasurementSampleError();
      }
      await client.query('COMMIT');
      return { outcome: 'duplicate' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async read(input: {
    tenantId: string;
    siteId: string;
    deviceId: string;
    componentId: string;
    channel: string;
    metric: string;
    from: string;
    to: string;
    limit?: number;
    sources?: readonly string[];
  }): Promise<GenericMeasurement[]> {
    const from = new Date(canonicalReadTime(input.from));
    const to = new Date(canonicalReadTime(input.to));
    if (from >= to) {
      throw new Error('Invalid measurement history interval');
    }
    const identifiers = [input.tenantId, input.siteId, input.deviceId,
      input.componentId, input.channel, input.metric];
    if (identifiers.some(item => typeof item !== 'string' || !item.trim())) {
      throw new Error('Measurement history identity is required');
    }
    const limit = input.limit ?? 10_000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) {
      throw new Error('Invalid measurement history limit');
    }
    const sources = input.sources ? [...new Set(input.sources)].filter(value => value.trim()) : null;
    if (sources && !sources.length) return [];
    const sourceClause = sources ? ' AND source=ANY($10::text[])' : '';
    const params: unknown[] = [...identifiers, from.toISOString(), to.toISOString(), limit];
    if (sources) params.push(sources);
    const result = await this.pool.query(
      `SELECT ${COLUMNS} FROM telemetry.measurements
       WHERE tenant_id=$1 AND site_id=$2 AND device_id=$3 AND component_id=$4
         AND channel=$5 AND metric=$6 AND observed_at >= $7 AND observed_at < $8
         ${sourceClause}
       ORDER BY observed_at,sample_id LIMIT $9`,
      params,
    );
    return result.rows.map(row => fromRow(row, this.definitions));
  }

  /** Return the newest accepted sample for one already-authorized stream. */
  async latest(input: {
    tenantId: string;
    siteId: string;
    deviceId: string;
    componentId: string;
    channel: string;
    metric: string;
    sources?: readonly string[];
  }): Promise<GenericMeasurement | null> {
    const identifiers = [input.tenantId, input.siteId, input.deviceId,
      input.componentId, input.channel, input.metric];
    if (identifiers.some(item => typeof item !== 'string' || !item.trim())) {
      throw new Error('Measurement history identity is required');
    }
    if (!this.definitions.some(definition => definition.metric === input.metric)) {
      throw new Error('Unsupported measurement metric');
    }
    const sources = input.sources ? [...new Set(input.sources)].filter(value => value.trim()) : null;
    if (sources && !sources.length) return null;
    const sourceClause = sources ? ' AND source=ANY($7::text[])' : '';
    const params: unknown[] = identifiers;
    if (sources) params.push(sources);
    const result = await this.pool.query(
      `SELECT ${COLUMNS} FROM telemetry.measurements
       WHERE tenant_id=$1 AND site_id=$2 AND device_id=$3 AND component_id=$4
         AND channel=$5 AND metric=$6
         ${sourceClause}
       ORDER BY observed_at DESC,received_at DESC,sample_id DESC LIMIT 1`,
      params,
    );
    return result.rows[0] ? fromRow(result.rows[0], this.definitions) : null;
  }

  /** Return bounded stream metadata without exposing measurement values. */
  async summarize(input: {
    tenantId: string;
    siteId: string;
    deviceId: string;
    authorizedSourcesByMetric: Readonly<Record<string, readonly string[]>>;
  }): Promise<Array<{ metric: string; count: number; oldest: string; newest: string }>> {
    if ([input.tenantId, input.siteId, input.deviceId].some(value => !value?.trim()))
      throw new Error('Measurement history identity is required');
    const authorizedStreams = Object.entries(input.authorizedSourcesByMetric)
      .filter(([metric]) => this.definitions.some(definition => definition.metric === metric))
      .map(([metric, values]) => ({
        metric,
        sources: [...new Set(values)].filter(source => source.trim().length > 0),
      }))
      .filter(stream => stream.sources.length > 0);
    if (!authorizedStreams.length) return [];

    const params: unknown[] = [input.tenantId, input.siteId, input.deviceId];
    const sourceClauses = authorizedStreams.map(stream => {
      params.push(stream.metric);
      const metricParameter = `$${params.length}`;
      params.push(stream.sources);
      const sourcesParameter = `$${params.length}`;
      return `(metric=${metricParameter} AND source=ANY(${sourcesParameter}::text[]))`;
    });
    const result = await this.pool.query(
      `SELECT metric,count(*)::int AS count,min(observed_at) AS oldest,max(observed_at) AS newest
       FROM telemetry.measurements
       WHERE tenant_id=$1 AND site_id=$2 AND device_id=$3 AND component_id='device'
         AND (${sourceClauses.join(' OR ')})
       GROUP BY metric`,
      params,
    );
    return result.rows.map(row => ({
      metric: String(row.metric),
      count: Number(row.count),
      oldest: new Date(row.oldest).toISOString(),
      newest: new Date(row.newest).toISOString(),
    }));
  }
}

function fromRow(row: Record<string, unknown>, definitions: readonly MeasurementDefinition[]): GenericMeasurement {
  return validateGenericMeasurement({
      schemaVersion: row.schema_version,
      tenantId: row.tenant_id,
      siteId: row.site_id,
      deviceId: row.device_id,
      physicalDeviceId: row.physical_device_id,
      componentId: row.component_id,
      channel: row.channel,
      metric: row.metric,
      unit: row.unit,
      value: row.value,
      quality: row.quality,
      source: row.source,
      provenance: row.provenance,
      sampleId: row.sample_id,
      observedAt: databaseInstant(row.observed_at),
      receivedAt: databaseInstant(row.received_at),
    }, definitions);
}

function databaseInstant(value: unknown): string {
  const date = value instanceof Date
    ? value
    : typeof value === 'string' || typeof value === 'number'
      ? new Date(value)
      : null;
  if (!date || !Number.isFinite(date.getTime())) throw new Error('Invalid database measurement timestamp');
  return date.toISOString();
}

function values(m: GenericMeasurement): unknown[] {
  return [m.tenantId, m.siteId, m.deviceId, m.physicalDeviceId, m.componentId,
    m.channel, m.metric, m.unit, m.value, m.quality, m.source, m.provenance,
    m.sampleId, m.observedAt, m.receivedAt];
}

function identityValues(m: GenericMeasurement): unknown[] {
  return [m.tenantId, m.siteId, m.deviceId, m.componentId, m.channel, m.metric, m.sampleId];
}

function sameSample(row: Record<string, unknown>, m: GenericMeasurement): boolean {
  const observedAt = row.observed_at instanceof Date
    ? row.observed_at.toISOString()
    : new Date(row.observed_at as string).toISOString();
  return row.physical_device_id === m.physicalDeviceId && row.unit === m.unit &&
    row.value === m.value && row.quality === m.quality && row.source === m.source &&
    row.provenance === m.provenance && observedAt === m.observedAt;
}

function canonicalReadTime(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new Error('Invalid measurement history interval');
  }
  return new Date(value).toISOString();
}
