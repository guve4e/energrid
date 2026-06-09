import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../db.module';
import { RiverStationReading } from './river.types';

@Injectable()
export class RiverHistoryService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async saveReadings(readings: RiverStationReading[]) {
    for (const reading of readings) {
      await this.pool.query(
        `
        INSERT INTO river_readings (
          station,
          provider,
          level_cm,
          discharge_m3s,
          difference_24h_cm,
          trend,
          water_temp_c,
          elevation_m,
          fetched_at,
          fetched_hour
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,date_trunc('hour', $9::timestamptz))
        ON CONFLICT (station, provider, fetched_hour) DO NOTHING
        `,
        [
          reading.station,
          reading.provider,
          reading.levelCm,
          reading.dischargeM3s,
          reading.difference24hCm,
          reading.trend,
          reading.waterTempC,
          reading.elevationM,
          reading.fetchedAt,
        ],
      );
    }

    return { processed: readings.length };
  }

  async getRecent(station: string, limit = 48) {
    const result = await this.pool.query(
      `
      SELECT
        station,
        provider,
        level_cm::float AS "levelCm",
        discharge_m3s::float AS "dischargeM3s",
        difference_24h_cm::float AS "difference24hCm",
        trend,
        water_temp_c::float AS "waterTempC",
        elevation_m::float AS "elevationM",
        fetched_at AS "fetchedAt"
      FROM river_readings
      WHERE station = $1
      ORDER BY fetched_at DESC
      LIMIT $2
      `,
      [station, limit],
    );

    return result.rows;
  }

  async getTrendSummary(station: string) {
    const result = await this.pool.query(
      `
      SELECT
        level_cm::float AS "levelCm",
        fetched_at AS "fetchedAt"
      FROM river_readings
      WHERE station = $1
        AND level_cm IS NOT NULL
        AND fetched_at >= now() - interval '24 hours'
      ORDER BY fetched_at ASC
      `,
      [station],
    );

    const rows = result.rows;

    if (rows.length < 2) {
      return {
        points: rows.length,
        last24hChangeCm: null,
        last12hChangeCm: null,
        last6hChangeCm: null,
        historyTrend: 'unknown',
      };
    }

    const last = rows[rows.length - 1];

    const changeFromHours = (hours: number) => {
      const cutoff = Date.now() - hours * 60 * 60 * 1000;
      const windowRows = rows.filter(
        (row) => new Date(row.fetchedAt).getTime() >= cutoff,
      );

      if (windowRows.length < 2) return null;

      const first = windowRows[0];
      const final = windowRows[windowRows.length - 1];

      return Number(final.levelCm) - Number(first.levelCm);
    };

    const first24h = rows[0];
    const last24hChangeCm = Number(last.levelCm) - Number(first24h.levelCm);
    const last12hChangeCm = changeFromHours(12);
    const last6hChangeCm = changeFromHours(6);

    const recentChange = last6hChangeCm ?? last12hChangeCm ?? last24hChangeCm;

    let historyTrend = 'stable';
    if (recentChange >= 3) historyTrend = 'rising';
    if (recentChange <= -3) historyTrend = 'falling';

    return {
      points: rows.length,
      last24hChangeCm,
      last12hChangeCm,
      last6hChangeCm,
      historyTrend,
    };
  }
}
