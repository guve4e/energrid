import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../db.module';

export type RiverHistoricalMetric =
  | 'water_level'
  | 'water_discharge'
  | 'water_temperature';

export type RiverHistoricalAssessment =
  | 'record-low'
  | 'near-record-low'
  | 'exceptionally-low'
  | 'below-normal'
  | 'normal'
  | 'above-normal'
  | 'exceptionally-high'
  | 'near-record-high'
  | 'record-high';

export interface RiverHistoricalContext {
  station: string;
  metric: RiverHistoricalMetric;
  unit: 'cm' | 'm3/s' | 'C';
  currentValue: number;
  coverage: {
    from: string;
    to: string;
    observations: number;
    years: number;
  };
  allTime: {
    minimum: number;
    minimumDate: string;
    maximum: number;
    maximumDate: string;
    median: number;
    percentile: number;
  };
  seasonal: {
    month: number;
    minimum: number;
    minimumDate: string;
    maximum: number;
    maximumDate: string;
    median: number;
    percentile: number;
  };
  assessment: RiverHistoricalAssessment;
}

/**
 * Temporary compatibility type for existing level-specific consumers.
 *
 * This keeps the regional intelligence endpoint stable while the generic
 * historical API is introduced.
 */
export interface RiverWaterLevelHistoricalContext
  extends RiverHistoricalContext {
  metric: 'water_level';
  unit: 'cm';
  currentValueCm: number;
  allTime: RiverHistoricalContext['allTime'] & {
    minimumCm: number;
    maximumCm: number;
    medianCm: number;
  };
  seasonal: RiverHistoricalContext['seasonal'] & {
    minimumCm: number;
    maximumCm: number;
    medianCm: number;
  };
}

const METRIC_UNITS: Record<
  RiverHistoricalMetric,
  RiverHistoricalContext['unit']
> = {
  water_level: 'cm',
  water_discharge: 'm3/s',
  water_temperature: 'C',
};

@Injectable()
export class RiverHistoricalContextService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async getContext(
    stationCode: string,
    metric: RiverHistoricalMetric,
    currentValue: number,
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
        JOIN river_stations s
          ON s.id = r.station_id
        JOIN river_historical_datasets d
          ON d.id = r.dataset_id
        WHERE s.code = $1
          AND d.metric = $2
      ),
      all_time AS (
        SELECT
          count(*)::int AS observations,
          to_char(min(observed_date), 'YYYY-MM-DD') AS coverage_from,
          to_char(max(observed_date), 'YYYY-MM-DD') AS coverage_to,
          min(value) AS minimum,
          max(value) AS maximum,
          percentile_cont(0.5)
            WITHIN GROUP (ORDER BY value) AS median,
          100.0
            * count(*) FILTER (WHERE value <= $3)
            / NULLIF(count(*), 0) AS percentile
        FROM source
      ),
      all_time_minimum_row AS (
        SELECT observed_date, value
        FROM source
        ORDER BY value ASC, observed_date ASC
        LIMIT 1
      ),
      all_time_maximum_row AS (
        SELECT observed_date, value
        FROM source
        ORDER BY value DESC, observed_date ASC
        LIMIT 1
      ),
      seasonal_source AS (
        SELECT observed_date, value
        FROM source
        WHERE EXTRACT(MONTH FROM observed_date) = $4
      ),
      seasonal AS (
        SELECT
          min(value) AS minimum,
          max(value) AS maximum,
          percentile_cont(0.5)
            WITHIN GROUP (ORDER BY value) AS median,
          100.0
            * count(*) FILTER (WHERE value <= $3)
            / NULLIF(count(*), 0) AS percentile
        FROM seasonal_source
      ),
      seasonal_minimum_row AS (
        SELECT observed_date, value
        FROM seasonal_source
        ORDER BY value ASC, observed_date ASC
        LIMIT 1
      ),
      seasonal_maximum_row AS (
        SELECT observed_date, value
        FROM seasonal_source
        ORDER BY value DESC, observed_date ASC
        LIMIT 1
      )
      SELECT
        a.observations,
        a.coverage_from,
        a.coverage_to,

        a.minimum,
        to_char(amin.observed_date, 'YYYY-MM-DD') AS minimum_date,

        a.maximum,
        to_char(amax.observed_date, 'YYYY-MM-DD') AS maximum_date,

        a.median,
        a.percentile,

        seasonal.minimum AS seasonal_minimum,
        to_char(smin.observed_date, 'YYYY-MM-DD')
          AS seasonal_minimum_date,

        seasonal.maximum AS seasonal_maximum,
        to_char(smax.observed_date, 'YYYY-MM-DD')
          AS seasonal_maximum_date,

        seasonal.median AS seasonal_median,
        seasonal.percentile AS seasonal_percentile
      FROM all_time a
      CROSS JOIN all_time_minimum_row amin
      CROSS JOIN all_time_maximum_row amax
      CROSS JOIN seasonal
      CROSS JOIN seasonal_minimum_row smin
      CROSS JOIN seasonal_maximum_row smax
      `,
      [stationCode, metric, currentValue, month],
    );

    if (!result.rowCount) {
      return null;
    }

    const row = result.rows[0];

    if (
      row.coverage_from == null ||
      row.coverage_to == null ||
      row.seasonal_percentile == null
    ) {
      return null;
    }

    const seasonalMinimum = Number(row.seasonal_minimum);
    const seasonalMaximum = Number(row.seasonal_maximum);
    const seasonalPercentile = Number(row.seasonal_percentile);

    return {
      station: stationCode,
      metric,
      unit: METRIC_UNITS[metric],
      currentValue,
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
        minimum: Number(row.minimum),
        minimumDate: row.minimum_date,
        maximum: Number(row.maximum),
        maximumDate: row.maximum_date,
        median: Number(row.median),
        percentile: Number(row.percentile),
      },
      seasonal: {
        month,
        minimum: seasonalMinimum,
        minimumDate: row.seasonal_minimum_date,
        maximum: seasonalMaximum,
        maximumDate: row.seasonal_maximum_date,
        median: Number(row.seasonal_median),
        percentile: seasonalPercentile,
      },
      assessment: this.classify(
        seasonalPercentile,
        currentValue,
        seasonalMinimum,
        seasonalMaximum,
      ),
    };
  }

  async getWaterLevelContext(
    stationCode: string,
    currentValueCm: number,
    observedAt = new Date(),
  ): Promise<RiverWaterLevelHistoricalContext | null> {
    const context = await this.getContext(
      stationCode,
      'water_level',
      currentValueCm,
      observedAt,
    );

    if (!context) {
      return null;
    }

    return {
      ...context,
      metric: 'water_level',
      unit: 'cm',
      currentValueCm,
      allTime: {
        ...context.allTime,
        minimumCm: context.allTime.minimum,
        maximumCm: context.allTime.maximum,
        medianCm: context.allTime.median,
      },
      seasonal: {
        ...context.seasonal,
        minimumCm: context.seasonal.minimum,
        maximumCm: context.seasonal.maximum,
        medianCm: context.seasonal.median,
      },
    };
  }

  async findAnalogues(
    stationCode: string,
    metric: RiverHistoricalMetric,
    currentValue: number,
    observedAt = new Date(),
    limit = 20,
  ) {
    const result = await this.pool.query(
      `
      SELECT
        r.observed_date,
        r.value::float AS value,
        ABS(r.value::float - $3) AS distance
      FROM river_historical_readings r
      JOIN river_stations s
        ON s.id = r.station_id
      JOIN river_historical_datasets d
        ON d.id = r.dataset_id
      WHERE
        s.code = $1
        AND d.metric = $2
        AND EXTRACT(month FROM r.observed_date)
            = EXTRACT(month FROM $4::date)
      ORDER BY
        distance ASC,
        r.observed_date DESC
      LIMIT $5
      `,
      [
        stationCode,
        metric,
        currentValue,
        observedAt,
        limit,
      ],
    );

    return result.rows.map((row) => ({
      date: row.observed_date,
      value: Number(row.value),
      distance: Number(row.distance),
    }));
  }


  private classify(
    percentile: number,
    currentValue: number,
    referenceMinimum: number,
    referenceMaximum: number,
  ): RiverHistoricalAssessment {
    if (currentValue <= referenceMinimum) {
      return 'record-low';
    }

    if (currentValue >= referenceMaximum) {
      return 'record-high';
    }

    const seasonalRange = Math.max(
      Math.abs(referenceMaximum - referenceMinimum),
      1,
    );

    const nearRecordTolerance = Math.max(seasonalRange * 0.01, 0.1);

    if (currentValue <= referenceMinimum + nearRecordTolerance) {
      return 'near-record-low';
    }

    if (currentValue >= referenceMaximum - nearRecordTolerance) {
      return 'near-record-high';
    }

    if (percentile <= 1) {
      return 'exceptionally-low';
    }

    if (percentile <= 15) {
      return 'below-normal';
    }

    if (percentile >= 99) {
      return 'exceptionally-high';
    }

    if (percentile >= 85) {
      return 'above-normal';
    }

    return 'normal';
  }
}
