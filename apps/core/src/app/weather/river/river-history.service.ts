import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../db.module';
import { RiverStationReading } from './river.types';
import { ForecastEngine } from './engines/forecast.engine';

@Injectable()
export class RiverHistoryService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly forecastEngine: ForecastEngine,
  ) {}

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



  async getStationHistory(
    station: string,
    limit = 48,
  ) {
    const result = await this.pool.query(
      `
      SELECT
        level_cm::float AS "levelCm",
        discharge_m3s::float AS "dischargeM3s",
        difference_24h_cm::float AS "difference24hCm",
        trend,
        fetched_at AS "fetchedAt"
      FROM river_readings
      WHERE station = $1
      ORDER BY fetched_at DESC
      LIMIT $2
      `,
      [station, limit],
    );

    return result.rows.reverse();
  }


  async getReadingClosestTo(
    station: string,
    timestamp: Date,
  ) {
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
      ORDER BY ABS(
        EXTRACT(
          EPOCH FROM (
            fetched_at - $2::timestamptz
          )
        )
      )
      LIMIT 1
      `,
      [station, timestamp],
    );

    return result.rows[0] ?? null;
  }

  async getLatestStationReading(station: string) {
    const result = await this.pool.query(
      `
      SELECT
        station,
        level_cm::float AS "levelCm",
        discharge_m3s::float AS "dischargeM3s",
        difference_24h_cm::float AS "difference24hCm",
        trend
      FROM river_readings
      WHERE station = $1
      ORDER BY fetched_at DESC
      LIMIT 1
      `,
      [station],
    );

    return result.rows[0] ?? null;
  }

  async getStationTrend(station: string, limit = 168) {
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
        AND level_cm IS NOT NULL
      ORDER BY fetched_at DESC
      LIMIT $2
      `,
      [station, limit],
    );

    const points = result.rows.reverse();

    if (points.length === 0) {
      return {
        station,
        currentCm: null,
        trend: 'unknown',
        rateCmPerHour: null,
        change24hCm: null,
        confidence: 'low',
        projection: null,
        points: [],
      };
    }

    const first = points[0];
    const last = points[points.length - 1];

    const hours =
      (new Date(last.fetchedAt).getTime() - new Date(first.fetchedAt).getTime()) /
      36e5;

    const totalChange = Number(last.levelCm) - Number(first.levelCm);
    const rateCmPerHour = hours > 0 ? totalChange / hours : 0;

    const last24Cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const last24 = points.filter(
      (p) => new Date(p.fetchedAt).getTime() >= last24Cutoff,
    );

    const change24hCm =
      last24.length >= 2
        ? Number(last24[last24.length - 1].levelCm) - Number(last24[0].levelCm)
        : null;

    let trend: 'rising' | 'falling' | 'stable' | 'unknown' = 'stable';
    const signal = change24hCm ?? totalChange;

    if (signal >= 3) trend = 'rising';
    else if (signal <= -3) trend = 'falling';
    else if (points.length < 2) trend = 'unknown';

    const currentCm = Number(last.levelCm);

    const upstream =
      await this.getLatestStationReading(
        'Novo Selo',
      );

    const forecast =
      this.forecastEngine.predict({
        currentCm,
        hours,
        totalChange,
        points: points.length,
        change24hCm,

        upstreamTrend:
          upstream?.trend,

        upstreamDischarge:
          upstream?.dischargeM3s,
      });

    return {
      station,
      currentCm,
      trend: forecast.trend,
      rateCmPerHour: forecast.rateCmPerHour,
      change24hCm,
      confidence: forecast.confidence,
      projection: forecast.projection,
      /*
      projection: {
        next6h: {
          expectedCm: Math.round(projected6h),
          minCm: Math.round(projected6h - uncertainty),
          maxCm: Math.round(projected6h + uncertainty),
          direction,
        },
        next24h: {
          expectedCm: Math.round(projected24h),
          minCm: Math.round(projected24h - uncertainty),
          maxCm: Math.round(projected24h + uncertainty),
          direction,
        },
      */
      points: points.map((p) => ({
        fetchedAt: p.fetchedAt,
        levelCm: Number(p.levelCm),
        provider: p.provider,
      })),
    };
  }

}
