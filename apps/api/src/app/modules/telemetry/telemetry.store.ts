import { Inject, Injectable } from '@nestjs/common';
import {
  type ElectricalReading,
  summarizeElectricalHour,
  validateElectricalReading,
} from '@energrid/domain-telemetry';
import { Pool } from 'pg';
import { TELEMETRY_POOL } from './telemetry.config';

export interface MeasurementStream {
  tenantId: string;
  siteId: string;
  deviceId: string;
  channel: string;
  metric: ElectricalReading['metric'];
}
export const streamValues = (s: MeasurementStream) => [
  s.tenantId,
  s.siteId,
  s.deviceId,
  s.channel,
  s.metric,
];
const match =
  'tenant_id=$1 AND site_id=$2 AND device_id=$3 AND channel=$4 AND metric=$5';

export class ConflictingElectricalReadingError extends Error {
  constructor() {
    super('Conflicting reading at an existing measurement timestamp');
  }
}

export function storedReading(row: Record<string, unknown>): ElectricalReading {
  return validateElectricalReading({
    schemaVersion: row.schema_version,
    tenantId: row.tenant_id,
    siteId: row.site_id,
    deviceId: row.device_id,
    channel: row.channel,
    metric: row.metric,
    value: row.value,
    unit: row.unit,
    quality: row.quality,
    observedAt: (row.observed_at as Date).toISOString(),
    receivedAt: (row.received_at as Date).toISOString(),
    timestampBasis: row.timestamp_basis,
    source: row.source,
  });
}

@Injectable()
export class TelemetryStore {
  constructor(@Inject(TELEMETRY_POOL) private readonly pool: Pool | null) {}

  async close() {
    await this.pool?.end();
  }

  private database(): Pool {
    if (!this.pool) throw new Error('Telemetry storage is disabled');
    return this.pool;
  }

  async append(input: ElectricalReading): Promise<'stored' | 'duplicate'> {
    const r = validateElectricalReading(input);
    const client = await this.database().connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO telemetry.readings
        (schema_version,tenant_id,site_id,device_id,channel,metric,value,unit,quality,observed_at,received_at,timestamp_basis,source)
        VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (tenant_id,site_id,device_id,channel,metric,observed_at) DO NOTHING RETURNING observed_at`,
        [
          ...streamValues(r),
          r.value,
          r.unit,
          r.quality,
          r.observedAt,
          r.receivedAt,
          r.timestampBasis,
          r.source,
        ],
      );
      if (!inserted.rowCount) {
        const existing = await client.query(
          `SELECT value,quality,unit,timestamp_basis,source FROM telemetry.readings WHERE ${match} AND observed_at=$6`,
          [...streamValues(r), r.observedAt],
        );
        const old = existing.rows[0];
        if (
          !old ||
          old.value !== r.value ||
          old.quality !== r.quality ||
          old.unit !== r.unit ||
          old.timestamp_basis !== r.timestampBasis ||
          old.source !== r.source
        )
          throw new ConflictingElectricalReadingError();
        await client.query('COMMIT');
        return 'duplicate';
      }
      // A new point can change the interval on either side, including adjacent hours.
      await client.query(
        `INSERT INTO telemetry.dirty_hours (tenant_id,site_id,device_id,channel,metric,hour)
        SELECT $1,$2,$3,$4,$5,h FROM generate_series(
          date_trunc('hour',$6::timestamptz - interval '5 minutes','UTC'),
          date_trunc('hour',$6::timestamptz + interval '5 minutes','UTC'), interval '1 hour') h
        ON CONFLICT (tenant_id,site_id,device_id,channel,metric,hour) DO UPDATE SET marked_at=now()`,
        [...streamValues(r), r.observedAt],
      );
      await client.query('COMMIT');
      return 'stored';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async read(
    stream: MeasurementStream,
    from: string,
    to: string,
  ): Promise<ElectricalReading[]> {
    const pool = this.database();
    const values = [...streamValues(stream), from, to];
    const result = await pool.query(
      `(SELECT * FROM telemetry.readings WHERE ${match}
        AND observed_at >= $6::timestamptz AND observed_at < $7::timestamptz ORDER BY observed_at LIMIT 100001)
      UNION ALL (SELECT * FROM telemetry.readings WHERE ${match} AND observed_at < $6::timestamptz
        AND observed_at >= $6::timestamptz - interval '5 minutes' ORDER BY observed_at DESC LIMIT 1)
      UNION ALL (SELECT * FROM telemetry.readings WHERE ${match} AND observed_at >= $7::timestamptz
        AND observed_at <= $7::timestamptz + interval '5 minutes' ORDER BY observed_at LIMIT 1)
      ORDER BY observed_at`,
      values,
    );
    if (
      result.rows.filter(
        (row) =>
          row.observed_at >= new Date(from) && row.observed_at < new Date(to),
      ).length > 100000
    )
      throw new Error('Too many telemetry readings. Choose a shorter period.');
    return result.rows.map(storedReading);
  }

  async hourly(stream: MeasurementStream, from: string, to: string) {
    const result = await this.database().query(
      `SELECT hour,statistics,updated_at FROM telemetry.hourly
      WHERE ${match} AND hour >= $6::timestamptz AND hour < $7::timestamptz ORDER BY hour`,
      [...streamValues(stream), from, to],
    );
    return result.rows.map((row) => ({
      ...row.statistics,
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async refreshOneHour(): Promise<boolean> {
    const client = await this.database().connect();
    try {
      await client.query('BEGIN');
      const work =
        await client.query(`SELECT * FROM telemetry.dirty_hours ORDER BY marked_at
        LIMIT 1 FOR UPDATE SKIP LOCKED`);
      const row = work.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return false;
      }
      const stream: MeasurementStream = {
        tenantId: row.tenant_id,
        siteId: row.site_id,
        deviceId: row.device_id,
        channel: row.channel,
        metric: row.metric,
      };
      const hour = row.hour.toISOString();
      const samples = await client.query(
        `SELECT * FROM telemetry.readings WHERE ${match}
        AND observed_at >= $6::timestamptz - interval '5 minutes'
        AND observed_at <= $6::timestamptz + interval '65 minutes' ORDER BY observed_at LIMIT 100001`,
        [...streamValues(stream), hour],
      );
      if (samples.rows.length > 100000)
        throw new Error('Too many samples in a telemetry hour');
      const statistics = summarizeElectricalHour(
        samples.rows.map(storedReading),
        hour,
      );
      await client.query(
        `INSERT INTO telemetry.hourly (tenant_id,site_id,device_id,channel,metric,hour,statistics)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (tenant_id,site_id,device_id,channel,metric,hour)
        DO UPDATE SET statistics=EXCLUDED.statistics,updated_at=now()`,
        [...streamValues(stream), hour, JSON.stringify(statistics)],
      );
      await client.query(
        `DELETE FROM telemetry.dirty_hours WHERE ${match} AND hour=$6`,
        [...streamValues(stream), hour],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
