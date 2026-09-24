import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../../db.module';
import { riverDirection, scoreForecast } from '../../../forecast/forecast-verification';

@Injectable()
export class RiverForecastEvaluatorService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async evaluateDueForecasts(limit = 100) {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 1000)) : 100;
    // Complete the +/-90 minute window, preserve gauge/provider identity, and
    // match before LIMIT so old forecasts without readings cannot starve newer ones.
    const due = await this.pool.query(`SELECT f.id, f.predicted_level::float AS predicted,
      f.predicted_min::float AS minimum,f.predicted_max::float AS maximum,
      f.observed_level_at_issue::float AS baseline,f.predicted_direction AS direction,
      r.level_cm::float AS actual,r.fetched_at AS "readingAt",r.provider
      FROM river_forecasts f JOIN LATERAL (
        SELECT r.* FROM river_readings r
        WHERE lower(r.station)=lower(f.station)
          AND r.provider=f.input_snapshot->'sourceReading'->>'provider'
          AND r.level_cm IS NOT NULL
          AND r.level_cm::float>'-Infinity'::float8 AND r.level_cm::float<'Infinity'::float8
          AND r.fetched_at>f.issued_at AND r.fetched_at>f.created_at
          AND r.fetched_at BETWEEN f.target_at-interval '90 minutes' AND f.target_at+interval '90 minutes'
        ORDER BY abs(extract(epoch FROM r.fetched_at-f.target_at)),r.fetched_at,r.level_cm LIMIT 1
      ) r ON true
      WHERE f.evaluated_at IS NULL AND f.verification_version='river-score-v2'
        AND f.target_at+interval '90 minutes'<=now()
        AND f.created_at<f.target_at AND f.issued_at<f.target_at
      ORDER BY f.target_at,f.id LIMIT $1`, [safeLimit]);
    let evaluated = 0;
    for (const f of due.rows) {
      if (![f.predicted, f.actual, f.baseline].every(Number.isFinite)) continue;
      const score = scoreForecast(f.predicted, f.actual, f.minimum, f.maximum);
      const result = await this.pool.query(`UPDATE river_forecasts SET actual_level=$2,signed_error=$3,
        absolute_error=$4,range_hit=$5,direction_correct=$6,evaluated_at=now(),actual_provider=$7,
        actual_reading_at=$8,observation_time_basis='provider-time-unverified',baseline_absolute_error=$9
        WHERE id=$1 AND evaluated_at IS NULL RETURNING id`,
      [f.id,f.actual,score.signedError,score.absoluteError,score.rangeHit,
        f.direction === 'unknown' ? null : f.direction === riverDirection(f.actual-f.baseline),
        f.provider,f.readingAt,Math.abs(f.actual-f.baseline)]);
      evaluated += result.rowCount ?? 0;
    }
    return { due: due.rows.length, evaluated, observationTimeBasis: 'provider-time-unverified' };
  }
}
