import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../db.module';

export interface RiverHistoricalContext {
  station: string;
  metric: 'water_level';
  currentValueCm: number;
  coverage: {
    from: string;
    to: string;
    observations: number;
    years: number;
  };
  allTime: {
    minimumCm: number;
    minimumDate: string;
    maximumCm: number;
    maximumDate: string;
    medianCm: number;
    percentile: number;
  };
  seasonal: {
    month: number;
    minimumCm: number;
    medianCm: number;
    percentile: number;
  };
  assessment:
    | 'record-low'
    | 'near-record-low'
    | 'exceptionally-low'
    | 'below-normal'
    | 'normal'
    | 'above-normal'
    | 'exceptionally-high';
}

@Injectable()
export class RiverHistoricalContextService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async getWaterLevelContext(
    stationCode: string,
    currentValueCm: number,
    observedAt = new Date(),
  ): Promise<RiverHistoricalContext | null> {
    const month = observedAt.getUTCMonth() + 1;

    const result = await this.pool.query(
      `
      WITH source AS (
        SELECT
          r.observed_date,
          r.value::float AS value
        FROM river_historical_readings r
        JOIN river_stations s ON s.id = r.station_id
        JOIN river_historical_datasets d ON d.id = r.dataset_id
        WHERE s.code = $1
          AND d.metric = 'water_level'
      ),
      all_time AS (
        SELECT
          count(*)::int AS observations,
          to_char(min(observed_date), 'YYYY-MM-DD') AS coverage_from,
          to_char(max(observed_date), 'YYYY-MM-DD') AS coverage_to,
          min(value) AS minimum_cm,
          max(value) AS maximum_cm,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY value) AS median_cm,
          100.0 * count(*) FILTER (WHERE value <= $2) / count(*) AS percentile
        FROM source
      ),
      minimum_row AS (
        SELECT observed_date, value
        FROM source
        ORDER BY value ASC, observed_date ASC
        LIMIT 1
      ),
      maximum_row AS (
        SELECT observed_date, value
        FROM source
        ORDER BY value DESC, observed_date ASC
        LIMIT 1
      ),
      seasonal AS (
        SELECT
          min(value) AS minimum_cm,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY value) AS median_cm,
          100.0 * count(*) FILTER (WHERE value <= $2) / count(*) AS percentile
        FROM source
        WHERE EXTRACT(MONTH FROM observed_date) = $3
      )
      SELECT
        a.observations,
        a.coverage_from,
        a.coverage_to,
        a.minimum_cm,
        to_char(minr.observed_date, 'YYYY-MM-DD') AS minimum_date,
        a.maximum_cm,
        to_char(maxr.observed_date, 'YYYY-MM-DD') AS maximum_date,
        a.median_cm,
        a.percentile,
        s.minimum_cm AS seasonal_minimum_cm,
        s.median_cm AS seasonal_median_cm,
        s.percentile AS seasonal_percentile
      FROM all_time a
      CROSS JOIN minimum_row minr
      CROSS JOIN maximum_row maxr
      CROSS JOIN seasonal s
      `,
      [stationCode, currentValueCm, month],
    );

    if (!result.rowCount) return null;

    const row = result.rows[0];
    const allTimePercentile = Number(row.percentile);
    const seasonalPercentile = Number(row.seasonal_percentile);

    return {
      station: stationCode,
      metric: 'water_level',
      currentValueCm,
      coverage: {
        from: row.coverage_from,
        to: row.coverage_to,
        observations: Number(row.observations),
        years:
          Number(String(row.coverage_to).slice(0, 4)) -
          Number(String(row.coverage_from).slice(0, 4)) +
          1,
      },
      allTime: {
        minimumCm: Number(row.minimum_cm),
        minimumDate: row.minimum_date,
        maximumCm: Number(row.maximum_cm),
        maximumDate: row.maximum_date,
        medianCm: Number(row.median_cm),
        percentile: allTimePercentile,
      },
      seasonal: {
        month,
        minimumCm: Number(row.seasonal_minimum_cm),
        medianCm: Number(row.seasonal_median_cm),
        percentile: seasonalPercentile,
      },
      assessment: this.classify(
        seasonalPercentile,
        currentValueCm,
        Number(row.seasonal_minimum_cm),
      ),
    };
  }

  private classify(
    percentile: number,
    currentValueCm: number,
    referenceMinimumCm: number,
  ): RiverHistoricalContext['assessment'] {
    if (currentValueCm <= referenceMinimumCm) return 'record-low';
    if (currentValueCm <= referenceMinimumCm + 10) {
      return 'near-record-low';
    }
    if (percentile <= 1) return 'exceptionally-low';
    if (percentile <= 15) return 'below-normal';
    if (percentile >= 99) return 'exceptionally-high';
    if (percentile >= 85) return 'above-normal';
    return 'normal';
  }
}
