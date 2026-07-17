import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';

import { PG_POOL } from '../../../db.module';

@Injectable()
export class RiverForecastPerformanceService {
  constructor(
    @Inject(PG_POOL)
    private readonly pool: Pool,
  ) {}

  async getPerformance(station: string, days = 90) {
    const safeDays = Math.max(1, Math.min(days, 3650));

    const summary = await this.pool.query(
      `
        SELECT
          station,
          model_version
            AS "modelVersion",
          horizon_hours
            AS "horizonHours",

          count(*)::int
            AS samples,

          avg(
            absolute_error
          )::float
            AS "maeCm",

          sqrt(
            avg(
              signed_error *
              signed_error
            )
          )::float
            AS "rmseCm",

          avg(
            signed_error
          )::float
            AS "biasCm",

          100.0 *
            avg(
              CASE
                WHEN range_hit IS TRUE
                THEN 1
                WHEN range_hit IS FALSE
                THEN 0
                ELSE NULL
              END
            )::float
            AS "rangeHitPct",

          100.0 *
            avg(
              CASE
                WHEN direction_correct IS TRUE
                THEN 1
                WHEN direction_correct IS FALSE
                THEN 0
                ELSE NULL
              END
            )::float
            AS "directionAccuracyPct",

          min(issued_at)
            AS "firstIssuedAt",

          max(evaluated_at)
            AS "lastEvaluatedAt"

        FROM river_forecasts

        WHERE lower(station) =
              lower($1)

          AND evaluated_at IS NOT NULL

          AND issued_at >=
              now() -
              make_interval(
                days => $2
              )

        GROUP BY
          station,
          model_version,
          horizon_hours

        ORDER BY
          model_version,
          horizon_hours
        `,
      [station, safeDays],
    );

    const pending = await this.pool.query(
      `
        SELECT
          horizon_hours
            AS "horizonHours",

          count(*)::int
            AS count

        FROM river_forecasts

        WHERE lower(station) =
              lower($1)

          AND evaluated_at IS NULL

        GROUP BY
          horizon_hours

        ORDER BY
          horizon_hours
        `,
      [station],
    );

    const recent = await this.pool.query(
      `
        SELECT
          id::text AS id,

          station,

          model_version
            AS "modelVersion",

          horizon_hours
            AS "horizonHours",

          issued_at
            AS "issuedAt",

          target_at
            AS "targetAt",

          predicted_level::float
            AS "predictedLevelCm",

          actual_level::float
            AS "actualLevelCm",

          signed_error::float
            AS "signedErrorCm",

          absolute_error::float
            AS "absoluteErrorCm",

          range_hit
            AS "rangeHit",

          direction_correct
            AS "directionCorrect",

          confidence,

          confidence_score::float
            AS "confidenceScore"

        FROM river_forecasts

        WHERE lower(station) =
              lower($1)

          AND evaluated_at IS NOT NULL

        ORDER BY
          evaluated_at DESC

        LIMIT 20
        `,
      [station],
    );

    return {
      station,
      windowDays: safeDays,

      summary: summary.rows.map((row) => ({
        ...row,

        maeCm: this.roundNullable(row.maeCm),

        rmseCm: this.roundNullable(row.rmseCm),

        biasCm: this.roundNullable(row.biasCm),

        rangeHitPct: this.roundNullable(row.rangeHitPct, 1),

        directionAccuracyPct: this.roundNullable(row.directionAccuracyPct, 1),
      })),

      pending: pending.rows,

      recent: recent.rows,

      generatedAt: new Date().toISOString(),
    };
  }

  private roundNullable(value: number | null | undefined, digits = 2) {
    if (value == null) {
      return null;
    }

    const numeric = Number(value);

    if (!Number.isFinite(numeric)) {
      return null;
    }

    return Number(numeric.toFixed(digits));
  }
}
