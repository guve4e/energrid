import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';

import { PG_POOL } from '../../../db.module';
import {
  HistoricalAnalogueEngine,
  RiverState,
} from './historical-analogue.engine';

@Injectable()
export class HistoricalAnalogueService {
  constructor(
    @Inject(PG_POOL)
    private readonly pool: Pool,
    private readonly engine: HistoricalAnalogueEngine,
  ) {}

  async findBestMatches(
    station: string,
    current: RiverState,
    limit = 20,
  ) {
    const result = await this.pool.query(
      `
      WITH level_series AS (
        SELECT
          r.dataset_id,
          r.station_id,
          r.observed_date,
          r.value::float AS value
        FROM river_historical_readings r
        JOIN river_stations s
          ON s.id = r.station_id
        JOIN river_historical_datasets d
          ON d.id = r.dataset_id
        WHERE s.code = $1
          AND d.metric = 'water_level'
          AND (
            $2::int IS NULL
            OR EXTRACT(MONTH FROM r.observed_date) = $2
          )
      )
      SELECT
        today.observed_date,
        today.value,
        previous.value AS previous_day_value,
        tomorrow.value AS next_day_value
      FROM level_series today
      JOIN river_historical_readings previous
        ON previous.dataset_id = today.dataset_id
       AND previous.observed_date =
           today.observed_date - interval '1 day'
      JOIN river_historical_readings tomorrow
        ON tomorrow.dataset_id = today.dataset_id
       AND tomorrow.observed_date =
           today.observed_date + interval '1 day'
      ORDER BY today.observed_date
      `,
      [
        station,
        current.month ?? null,
      ],
    );

    const scored = result.rows
      .map((row) => {
        const level = Number(row.value);
        const previousDayLevel =
          Number(row.previous_day_value);
        const nextDayLevel =
          Number(row.next_day_value);

        const candidateDelta24h =
          level - previousDayLevel;

        return {
          observedDate: row.observed_date,
          level,
          candidateDelta24h,
          nextDayLevel,
          nextDayDelta:
            nextDayLevel - level,
          score: this.engine.score(
            current,
            {
              level,
              delta24h: candidateDelta24h,
              month: new Date(
                row.observed_date,
              ).getUTCMonth() + 1,
            },
          ),
        };
      })
      .sort(
        (left, right) =>
          left.score - right.score,
      )
      .slice(0, limit);

    const deltas = scored.map(
      (analogue) => analogue.nextDayDelta,
    );

    const averageDelta = deltas.length
      ? deltas.reduce(
          (sum, delta) => sum + delta,
          0,
        ) / deltas.length
      : null;

    const sortedDeltas = [...deltas].sort(
      (left, right) => left - right,
    );

    const medianDelta = sortedDeltas.length
      ? sortedDeltas.length % 2 === 1
        ? sortedDeltas[
            Math.floor(sortedDeltas.length / 2)
          ]
        : (
            sortedDeltas[
              sortedDeltas.length / 2 - 1
            ] +
            sortedDeltas[
              sortedDeltas.length / 2
            ]
          ) / 2
      : null;

    const fallingCount = deltas.filter(
      (delta) => delta <= -2,
    ).length;

    const risingCount = deltas.filter(
      (delta) => delta >= 2,
    ).length;

    const stableCount =
      deltas.length -
      fallingCount -
      risingCount;

    const dominantCount = Math.max(
      fallingCount,
      stableCount,
      risingCount,
    );

    const directionalAgreement = deltas.length
      ? dominantCount / deltas.length
      : 0;

    const direction =
      dominantCount === 0
        ? 'unknown'
        : dominantCount === fallingCount
          ? 'falling'
          : dominantCount === risingCount
            ? 'rising'
            : 'stable';

    const spread = deltas.length
      ? Math.max(...deltas) -
        Math.min(...deltas)
      : null;

    const confidence =
      scored.length < 10 ||
      spread == null
        ? 'low'
        : directionalAgreement >= 0.8 &&
            spread <= 8
          ? 'high'
          : directionalAgreement >= 0.65 &&
              spread <= 15
            ? 'medium'
            : 'low';

    return {
      analogues: scored,

      averageDelta:
        averageDelta == null
          ? null
          : Number(averageDelta.toFixed(2)),

      medianDelta:
        medianDelta == null
          ? null
          : Number(medianDelta.toFixed(2)),

      spread:
        spread == null
          ? null
          : Number(spread.toFixed(2)),

      direction,

      directionalAgreement:
        Number(
          (directionalAgreement * 100).toFixed(1),
        ),

      outcomes: {
        falling: fallingCount,
        stable: stableCount,
        rising: risingCount,
        total: deltas.length,
      },

      confidence,
    };
  }
}
