import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../db.module';
import { RiverStationReading } from './river.types';

/**
 * Source evidence is not a time series: fetchedAt is when we saw a page, not
 * necessarily when a gauge was measured. Do not use this table for forecasts.
 */
@Injectable()
export class RiverSourceObservationStore {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async record(readings: RiverStationReading[]) {
    let inserted = 0;
    let seenAgain = 0;
    let rejected = 0;

    for (const reading of readings) {
      if (!this.isValid(reading)) {
        rejected++;
        continue;
      }

      // Deliberately exclude fetchedAt from identity. Polling the same source
      // values twice is not evidence of two independent gauge measurements.
      const identity = [
        reading.provider, reading.station, reading.sourceReportedAt,
        reading.observedAt, reading.observationTimeBasis, reading.riverKm,
        reading.elevationM, reading.levelCm, reading.dischargeM3s,
        reading.difference24hCm, reading.trend, reading.waterTempC,
      ];
      const sourceKey = createHash('sha256').update(JSON.stringify(identity)).digest('hex');

      const result = await this.pool.query<{ inserted: boolean }>(
        `INSERT INTO river_source_observations (
          source_key, station, provider, source_reported_at, observed_at,
          observation_time_basis, river_km, elevation_m, level_cm,
          discharge_m3s, difference_24h_cm, trend, water_temp_c,
          first_fetched_at, last_fetched_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14
        )
        ON CONFLICT (source_key) DO UPDATE SET
          first_fetched_at = LEAST(river_source_observations.first_fetched_at, EXCLUDED.first_fetched_at),
          last_fetched_at = GREATEST(river_source_observations.last_fetched_at, EXCLUDED.last_fetched_at),
          poll_count = river_source_observations.poll_count + 1
        RETURNING (poll_count = 1) AS inserted`,
        [
          sourceKey, reading.station, reading.provider, reading.sourceReportedAt,
          reading.observedAt, reading.observationTimeBasis, reading.riverKm,
          reading.elevationM, reading.levelCm, reading.dischargeM3s,
          reading.difference24hCm, reading.trend, reading.waterTempC,
          reading.fetchedAt,
        ],
      );
      if (result.rows[0]?.inserted) inserted++;
      else seenAgain++;
    }

    return { inserted, seenAgain, rejected };
  }

  async getRecent(station: string, limit = 48) {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 500)) : 48;
    const result = await this.pool.query(
      `SELECT station, provider, level_cm::float AS "levelCm",
         discharge_m3s::float AS "dischargeM3s", river_km::float AS "riverKm",
         source_reported_at AS "sourceReportedAt", observed_at AS "observedAt",
         observation_time_basis AS "observationTimeBasis",
         first_fetched_at AS "firstFetchedAt", last_fetched_at AS "lastFetchedAt",
         poll_count AS "pollCount"
       FROM river_source_observations
       WHERE lower(station) = lower($1)
       ORDER BY last_fetched_at DESC, id DESC
       LIMIT $2`,
      [station, safeLimit],
    );
    return result.rows;
  }

  private isValid(reading: RiverStationReading): boolean {
    const instant = (value: string) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
      Number.isFinite(Date.parse(value));
    if (!reading.station.trim() || !reading.provider.trim() || !instant(reading.fetchedAt)) return false;
    if (!['verified', 'date-only', 'timezone-unverified', 'unknown'].includes(reading.observationTimeBasis)) return false;
    if (Date.parse(reading.fetchedAt) > Date.now() + 5 * 60_000) return false;
    if (reading.observationTimeBasis === 'verified') {
      if (!reading.observedAt || !instant(reading.observedAt) ||
          Date.parse(reading.observedAt) > Date.parse(reading.fetchedAt) + 5 * 60_000) return false;
    } else if (reading.observedAt !== null) return false;
    return [reading.riverKm, reading.elevationM, reading.levelCm,
      reading.dischargeM3s, reading.difference24hCm, reading.waterTempC]
      .every((value) => value === null || Number.isFinite(value));
  }
}
