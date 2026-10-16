import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db.module';
import { scoreForecast } from '../forecast/forecast-verification';
import { WeatherSnapshot } from './weather-data-quality';
import {
  DailyVerificationMetric,
  dailyPredictions,
  IntervalMeasurement,
  measuredDailyValue,
} from './weather-daily-verification';
import { VIDIN_LOCATION } from './weather-verification.service';

@Injectable()
export class WeatherDailyVerificationService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async record(
    snapshots: WeatherSnapshot[],
    selected: WeatherSnapshot,
    now = new Date(),
  ) {
    let recorded = 0;
    for (const prediction of dailyPredictions(snapshots, selected, now)) {
      const p = prediction;
      const result = await this.pool.query(
        `INSERT INTO weather_daily_forecasts
        (location,provider,model_version,issued_at,issued_hour,target_date,timezone,starts_at,ends_at,lead_days,metric,predicted,input_snapshot)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
        ON CONFLICT (location,provider,model_version,issued_hour,target_date,metric) DO NOTHING`,
        [
          p.location,
          p.provider,
          p.modelVersion,
          p.issuedAt,
          p.issuedHour,
          p.targetDate,
          p.timezone,
          p.startsAt,
          p.endsAt,
          p.leadDays,
          p.metric,
          p.predicted,
          JSON.stringify(p.input),
        ],
      );
      recorded += result.rowCount ?? 0;
    }
    return { recorded };
  }

  async evaluate(source: string, mode: 'hourly' | 'daily' = 'hourly') {
    if (!source) return { evaluated: 0 };
    if (mode === 'daily') return this.evaluateStationReports(source);
    // Join complete candidate windows before LIMIT so permanently missing days cannot starve newer data.
    const due = await this.pool.query(
      `SELECT f.*, o.measurements
      FROM weather_daily_forecasts f JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('id',o.id::text,'observedAt',o.observed_at,
          'windowStartAt',o.window_start_at,'value',o.value) ORDER BY o.observed_at) AS measurements
        FROM weather_observations o WHERE o.location=f.location AND o.source=$1 AND o.metric=f.metric
          AND o.window_start_at>=f.starts_at AND o.observed_at<=f.ends_at
          AND o.observed_at-o.window_start_at=interval '1 hour'
          AND mod(extract(epoch FROM (o.window_start_at-f.starts_at)),3600)=0
        HAVING count(*)=extract(epoch FROM (f.ends_at-f.starts_at))/3600
      ) o ON true
      WHERE f.evaluated_at IS NULL AND f.metric IN ('precipitation_mm','gust_kmh')
        AND f.ends_at<=now() AND f.created_at<f.starts_at
      ORDER BY f.ends_at,f.id LIMIT 500`,
      [source],
    );
    let evaluated = 0;
    for (const row of due.rows) {
      const actual = measuredDailyValue(
        row.metric as 'precipitation_mm' | 'gust_kmh',
        new Date(row.starts_at),
        new Date(row.ends_at),
        row.measurements as IntervalMeasurement[],
      );
      if (!actual) continue;
      const score = scoreForecast(row.predicted, actual.value);
      const result = await this.pool.query(
        `UPDATE weather_daily_forecasts SET actual=$2,observation_source=$3,
        observation_ids=$4,absolute_error=$5,squared_error=$6,signed_error=$7,evaluated_at=now()
        WHERE id=$1 AND evaluated_at IS NULL RETURNING id`,
        [
          row.id,
          actual.value,
          source,
          actual.observationIds,
          score.absoluteError,
          score.squaredError,
          score.signedError,
        ],
      );
      evaluated += result.rowCount ?? 0;
    }
    return { evaluated };
  }

  private async evaluateStationReports(source: string) {
    const due = await this.pool.query(`SELECT f.id,f.predicted,o.id AS observation_id,o.value AS observed_value
      FROM weather_daily_forecasts f JOIN weather_station_daily_observations o
        ON o.location=f.location AND o.source=$1 AND o.report_date=f.target_date AND o.metric=f.metric
        AND o.period_basis='local-calendar-day' AND o.timezone=f.timezone
        AND o.starts_at=f.starts_at AND o.ends_at=f.ends_at AND length(trim(o.period_reference))>0
      WHERE f.evaluated_at IS NULL AND f.ends_at<=now() AND f.created_at<f.starts_at
      ORDER BY f.ends_at,f.id LIMIT 500`, [source]);
    let evaluated = 0;
    for (const row of due.rows) {
      const score = scoreForecast(row.predicted,row.observed_value);
      const result = await this.pool.query(`UPDATE weather_daily_forecasts SET actual=$2,observation_source=$3,
        daily_observation_id=$4,observation_time_basis='station-daily-local-calendar-day',
        absolute_error=$5,squared_error=$6,signed_error=$7,evaluated_at=now()
        WHERE id=$1 AND evaluated_at IS NULL RETURNING id`,
      [row.id,row.observed_value,source,row.observation_id,score.absoluteError,score.squaredError,score.signedError]);
      evaluated += result.rowCount ?? 0;
    }
    return { evaluated };
  }

  async performance(location = VIDIN_LOCATION) {
    const summary = await this.pool.query(
      `SELECT provider,model_version AS "modelVersion",metric,lead_days AS "leadDays",
      observation_source AS "observationSource",observation_time_basis AS "observationTimeBasis",count(*)::int AS samples,
      count(DISTINCT target_date)::int AS "verifiedDays",avg(absolute_error) AS mae,
      sqrt(avg(squared_error)) AS rmse,avg(signed_error) AS bias
      FROM weather_daily_forecasts WHERE location=$1 AND evaluated_at IS NOT NULL AND issued_at>=now()-interval '90 days'
      GROUP BY provider,model_version,metric,lead_days,observation_source,observation_time_basis ORDER BY metric,lead_days,model_version`,
      [location],
    );
    const recent = await this.pool.query(
      `SELECT DISTINCT ON (target_date,lead_days,provider,model_version,metric,observation_source)
      target_date::text AS date,provider,model_version AS "modelVersion",metric,lead_days AS "leadDays",
      issued_at AS "issuedAt",predicted,actual,absolute_error AS "absoluteError",observation_source AS "observationSource",
      observation_time_basis AS "observationTimeBasis",
      input_snapshot->>'sourceModel' AS "sourceModel",input_snapshot->>'agreement' AS agreement
      FROM weather_daily_forecasts WHERE location=$1 AND evaluated_at IS NOT NULL AND issued_at>=now()-interval '90 days'
      ORDER BY target_date DESC,lead_days,provider,model_version,metric,observation_source,issued_at DESC LIMIT 120`,
      [location],
    );
    const pending = await this.pool.query(
      `SELECT count(*) FILTER (WHERE ends_at>now())::int AS scheduled,
      count(*) FILTER (WHERE ends_at<=now())::int AS "awaitingObservations"
      FROM weather_daily_forecasts WHERE location=$1 AND evaluated_at IS NULL AND issued_at>=now()-interval '90 days'`,
      [location],
    );
    return {
      status: summary.rows.length ? 'available' : 'awaiting-observations',
      summary: summary.rows,
      recent: recent.rows,
      pending: pending.rows[0],
      timezone: 'Europe/Sofia',
      note: 'Verified matching local days only. Native daily reports or complete hourly precipitation/gust intervals are kept separate by station and reporting basis. Unknown periods and missing metrics remain unscored. Samples are snapshots, not independent days.',
    };
  }
}
