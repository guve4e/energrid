import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';

import { PG_POOL } from '../../../db.module';

type Direction = 'rising' | 'falling' | 'stable' | 'unknown';

interface DueForecast {
  id: string;
  station: string;
  targetAt: Date;
  observedLevelAtIssue: number;
  predictedLevel: number;
  predictedMin: number | null;
  predictedMax: number | null;
  predictedDirection: Direction;
}

@Injectable()
export class RiverForecastEvaluatorService {
  private readonly logger = new Logger(RiverForecastEvaluatorService.name);

  private readonly matchToleranceMinutes = 90;

  constructor(
    @Inject(PG_POOL)
    private readonly pool: Pool,
  ) {}

  async evaluateDueForecasts(limit = 100) {
    const forecasts = await this.findDueForecasts(limit);

    let evaluated = 0;
    let awaitingReading = 0;

    for (const forecast of forecasts) {
      const actual = await this.findClosestReading(
        forecast.station,
        forecast.targetAt,
      );

      if (!actual) {
        awaitingReading += 1;
        continue;
      }

      const signedError = actual.levelCm - forecast.predictedLevel;

      const absoluteError = Math.abs(signedError);

      const rangeHit =
        forecast.predictedMin == null || forecast.predictedMax == null
          ? null
          : actual.levelCm >= forecast.predictedMin &&
            actual.levelCm <= forecast.predictedMax;

      const actualDirection = this.directionFromChange(
        actual.levelCm - forecast.observedLevelAtIssue,
      );

      const directionCorrect =
        forecast.predictedDirection === 'unknown'
          ? null
          : actualDirection === forecast.predictedDirection;

      const result = await this.pool.query(
        `
          UPDATE river_forecasts
          SET
            actual_level = $2,
            signed_error = $3,
            absolute_error = $4,
            range_hit = $5,
            direction_correct = $6,
            evaluated_at = now()
          WHERE id = $1
            AND evaluated_at IS NULL
          RETURNING id
          `,
        [
          forecast.id,
          actual.levelCm,
          signedError,
          absoluteError,
          rangeHit,
          directionCorrect,
        ],
      );

      if (result.rowCount) {
        evaluated += 1;
      }
    }

    if (forecasts.length || evaluated) {
      this.logger.log(
        [
          'Forecast evaluation complete',
          `due=${forecasts.length}`,
          `evaluated=${evaluated}`,
          `awaitingReading=${awaitingReading}`,
        ].join(' '),
      );
    }

    return {
      due: forecasts.length,
      evaluated,
      awaitingReading,
    };
  }

  private async findDueForecasts(limit: number): Promise<DueForecast[]> {
    const result = await this.pool.query(
      `
        SELECT
          id::text AS id,
          station,
          target_at AS "targetAt",

          observed_level_at_issue::float
            AS "observedLevelAtIssue",

          predicted_level::float
            AS "predictedLevel",

          predicted_min::float
            AS "predictedMin",

          predicted_max::float
            AS "predictedMax",

          predicted_direction
            AS "predictedDirection"

        FROM river_forecasts

        WHERE evaluated_at IS NULL
          AND target_at <= now()

        ORDER BY target_at ASC

        LIMIT $1
        `,
      [Math.max(1, Math.min(limit, 1000))],
    );

    return result.rows;
  }

  private async findClosestReading(
    station: string,
    targetAt: Date,
  ): Promise<{
    levelCm: number;
    fetchedAt: Date;
  } | null> {
    const tolerance = `${this.matchToleranceMinutes} minutes`;

    const result = await this.pool.query(
      `
        SELECT
          level_cm::float AS "levelCm",
          fetched_at AS "fetchedAt"

        FROM river_readings

        WHERE lower(station) =
              lower($1)

          AND level_cm IS NOT NULL

          AND fetched_at BETWEEN
              $2::timestamptz -
                $3::interval
              AND
              $2::timestamptz +
                $3::interval

        ORDER BY
          abs(
            extract(
              epoch FROM (
                fetched_at -
                $2::timestamptz
              )
            )
          ) ASC

        LIMIT 1
        `,
      [station, targetAt, tolerance],
    );

    return result.rows[0] ?? null;
  }

  private directionFromChange(changeCm: number): Exclude<Direction, 'unknown'> {
    if (changeCm >= 2) {
      return 'rising';
    }

    if (changeCm <= -2) {
      return 'falling';
    }

    return 'stable';
  }
}
