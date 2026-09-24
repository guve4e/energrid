import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db.module';
import { brierScore, scoreForecast } from '../forecast/forecast-verification';
import { assessWeather, HOUR_MS, WeatherSnapshot } from './weather-data-quality';

export const weatherLocation = (s: WeatherSnapshot) => `${s.coordinates.latitude.toFixed(5)},${s.coordinates.longitude.toFixed(5)}`;
export const VIDIN_LOCATION = '43.99160,22.87280';
const VERSION = 'weather-v1';

export interface WeatherObservation {
  metric: 'temperature_c' | 'gust_kmh' | 'precipitation_mm';
  observedAt: string;
  windowStartAt?: string;
  value: number;
}

@Injectable()
export class WeatherVerificationService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async record(snapshots: WeatherSnapshot[], selected?: WeatherSnapshot, now = new Date()) {
    const issuedAt = now.toISOString();
    const issuedHour = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
    // The selected forecast is scored as its own versioned decision policy.
    const candidates = snapshots.map(snapshot => ({ snapshot, model: `${snapshot.model}:${VERSION}` }));
    if (selected) candidates.push({ snapshot: selected, model: `selected-cautious:${VERSION}` });
    let recorded = 0;
    for (const { snapshot, model } of candidates) {
      if (!snapshot.model || !assessWeather(snapshot, now.getTime()).forecastUsable) continue;
      for (const horizon of [1, 6, 24]) {
        const target = new Date(issuedHour.getTime() + horizon * HOUR_MS);
        const hour = snapshot.hourly.find(h => Date.parse(h.time ?? '') === target.getTime());
        if (!hour || target <= now) continue;
        for (const [metric, value] of Object.entries({ temperature_c: hour.temperature, gust_kmh: hour.gustKmh,
          precipitation_mm: hour.precipitationMm, rain_probability: hour.rainChance == null ? null : hour.rainChance / 100 })) {
          if (value == null || !Number.isFinite(value)) continue;
          if (metric !== 'temperature_c' && value < 0) continue;
          if (metric === 'rain_probability' && value > 1) continue;
          const windowStart = metric === 'temperature_c' ? null : new Date(target.getTime() - HOUR_MS);
          // Never score a complete hourly interval after part of it was already observed.
          if (windowStart && windowStart < now) continue;
          const baseline = metric === 'temperature_c' && Number.isFinite(snapshot.current.temperature) ? snapshot.current.temperature : null;
          const result = await this.pool.query(`INSERT INTO weather_forecasts
            (location,provider,model_version,issued_at,issued_hour,target_at,window_start_at,horizon_hours,metric,predicted,baseline,input_snapshot)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
            ON CONFLICT (location,provider,model_version,issued_hour,horizon_hours,metric) DO NOTHING`,
          [weatherLocation(snapshot),snapshot.provider,model,issuedAt,issuedHour,target,windowStart,horizon,metric,value,baseline,
            JSON.stringify({ sourceModel: snapshot.model, fetchedAt: snapshot.fetchedAt, units: snapshot.units,
              current: snapshot.current, forecast: hour, policyVersion: VERSION, modelIssuedAt: null })]);
          recorded += result.rowCount ?? 0;
        }
      }
    }
    return { recorded };
  }

  async ingest(source: string, location: string, observations: WeatherObservation[]) {
    if (!source || !location || !Array.isArray(observations) || !observations.length || observations.length > 100) {
      throw new BadRequestException('Provide 1–100 observations from a configured station');
    }
    // Validate the whole batch before inserting anything. No client-supplied "trusted" flag.
    for (const o of observations) {
      if (!o || !['temperature_c','gust_kmh','precipitation_mm'].includes(o.metric) || typeof o.value !== 'number' || !Number.isFinite(o.value)) {
        throw new BadRequestException('Invalid observation metric or value');
      }
      const time = Date.parse(o.observedAt);
      if (!/(Z|[+-]\d\d:\d\d)$/.test(o.observedAt) || !Number.isFinite(time) || time > Date.now() + 60000 || time < Date.now() - 30 * 24 * HOUR_MS) {
        throw new BadRequestException('Observation time must include a timezone and be within the last 30 days');
      }
      if (o.metric === 'temperature_c') {
        if (o.windowStartAt != null || o.value < -100 || o.value > 70) throw new BadRequestException('Temperature requires an instantaneous Celsius reading');
      } else {
        if (!o.windowStartAt || !/(Z|[+-]\d\d:\d\d)$/.test(o.windowStartAt) || time - Date.parse(o.windowStartAt) !== HOUR_MS || o.value < 0 || o.value > 1000) {
          throw new BadRequestException('Gusts require an hourly maximum in km/h; rain requires an hourly total in mm, with a one-hour window');
        }
      }
    }
    const client = await this.pool.connect();
    let recorded = 0;
    try {
      await client.query('BEGIN');
      for (const o of observations) {
        const result = await client.query(`INSERT INTO weather_observations (location,source,metric,observed_at,window_start_at,value)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (location,source,metric,observed_at) DO NOTHING`,
        [location,source,o.metric,o.observedAt,o.windowStartAt ?? null,o.value]);
        recorded += result.rowCount ?? 0;
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return { recorded };
  }

  async evaluate() {
    // Wait until the matching window closes. Join eligible observations before LIMIT,
    // so old unmatched forecasts cannot block newer ones with available observations.
    const due = await this.pool.query(`SELECT f.*, o.id AS observation_id, o.value AS observed_value
      FROM weather_forecasts f JOIN LATERAL (
        SELECT o.* FROM weather_observations o
        WHERE o.location=f.location AND o.source=$1
          AND o.metric=CASE WHEN f.metric='rain_probability' THEN 'precipitation_mm' ELSE f.metric END
          AND o.observed_at>f.issued_at AND f.created_at<o.observed_at
          AND ((f.window_start_at IS NULL AND o.window_start_at IS NULL
            AND o.observed_at BETWEEN f.target_at-interval '15 minutes' AND f.target_at+interval '15 minutes')
            OR (o.window_start_at=f.window_start_at AND o.observed_at=f.target_at))
        ORDER BY abs(extract(epoch FROM o.observed_at-f.target_at)),o.observed_at,o.id LIMIT 1
      ) o ON true
      WHERE f.evaluated_at IS NULL AND f.target_at+interval '15 minutes'<=now()
        AND f.created_at<coalesce(f.window_start_at,f.target_at)
      ORDER BY f.target_at,f.id LIMIT 500`, [process.env.WEATHER_OBSERVATION_SOURCE ?? '']);
    let evaluated = 0;
    for (const row of due.rows) {
      const probability = row.metric === 'rain_probability';
      const actual = probability ? Number(row.observed_value > 0.1) : row.observed_value;
      const score = scoreForecast(row.predicted, actual);
      const result = await this.pool.query(`UPDATE weather_forecasts SET observation_id=$2,actual=$3,
        signed_error=$4,absolute_error=$5,squared_error=$6,brier_score=$7,baseline_absolute_error=$8,evaluated_at=now()
        WHERE id=$1 AND evaluated_at IS NULL RETURNING id`,
      [row.id,row.observation_id,actual,score.signedError,score.absoluteError,score.squaredError,
        probability ? brierScore(row.predicted, actual === 1) : null,
        row.baseline == null ? null : Math.abs(actual-row.baseline)]);
      evaluated += result.rowCount ?? 0;
    }
    return { evaluated };
  }

  async performance(location = VIDIN_LOCATION) {
    const summary = await this.pool.query(`SELECT f.provider,f.model_version AS "modelVersion",f.metric,f.horizon_hours AS "horizonHours",
      o.source AS "observationSource",count(*)::int AS samples,
      avg(f.absolute_error) AS mae,sqrt(avg(f.squared_error)) AS rmse,avg(f.signed_error) AS bias,
      avg(f.brier_score) AS "brierScore",avg(f.baseline_absolute_error) AS "baselineMae",
      CASE WHEN avg(f.baseline_absolute_error)>0 THEN
        1-(avg(f.absolute_error) FILTER (WHERE f.baseline_absolute_error IS NOT NULL))/avg(f.baseline_absolute_error) END AS "skillVsPersistence",
      max(f.evaluated_at) AS "lastEvaluatedAt"
      FROM weather_forecasts f JOIN weather_observations o ON o.id=f.observation_id
      WHERE f.location=$1 AND f.issued_at>=now()-interval '90 days' AND f.evaluated_at IS NOT NULL
      GROUP BY f.provider,f.model_version,f.metric,f.horizon_hours,o.source ORDER BY f.metric,f.horizon_hours,f.model_version`, [location]);
    const pending = await this.pool.query(`SELECT
      count(*) FILTER (WHERE target_at>now())::int AS scheduled,
      count(*) FILTER (WHERE target_at<=now())::int AS "awaitingObservations"
      FROM weather_forecasts WHERE location=$1 AND evaluated_at IS NULL AND issued_at>=now()-interval '90 days'`, [location]);
    return { status: summary.rows.length ? 'available' : 'awaiting-observations', location, windowDays: 90,
      observationSource: process.env.WEATHER_OBSERVATION_SOURCE || null,
      summary: summary.rows, pending: pending.rows[0], generatedAt: new Date().toISOString(),
      note: 'Scores use measured observations. Model agreement is not measured accuracy. Rain event: hourly total >0.1 mm.' };
  }
}
