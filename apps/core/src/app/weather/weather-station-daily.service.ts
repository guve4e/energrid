import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db.module';
import {
  STATION_DAILY_METRICS,
  StationDailyObservation,
} from './weather-station-daily';
import {
  validWeatherDate,
  weatherDate,
  weatherDayWindow,
  WEATHER_TIMEZONE,
} from './weather-calendar';
import { HOUR_MS } from './weather-data-quality';

export const DAILY_REVISION_MESSAGE =
  'Station revised a saved daily report. Existing observations and scores were not overwritten.';

@Injectable()
export class WeatherStationDailyService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async claimCollection(source: string, now: Date) {
    const claim = await this.pool.query(
      `INSERT INTO weather_observation_collection_runs(source,last_attempt_at)
      VALUES ($1,$2) ON CONFLICT(source) DO UPDATE SET last_attempt_at=EXCLUDED.last_attempt_at
      WHERE weather_observation_collection_runs.last_attempt_at<=EXCLUDED.last_attempt_at-interval '24 hours'
      RETURNING source`,
      [source, now],
    );
    if (claim.rowCount) return { claimed: true };
    const previous = await this.pool.query(
      'SELECT status_snapshot FROM weather_observation_collection_runs WHERE source=$1',
      [source],
    );
    return {
      claimed: false,
      snapshot: previous.rows[0]?.status_snapshot ?? null,
    };
  }

  async saveCollectionStatus(source: string, status: unknown) {
    await this.pool.query(
      'UPDATE weather_observation_collection_runs SET status_snapshot=$2::jsonb WHERE source=$1',
      [source, JSON.stringify(status)],
    );
  }

  async ingest(
    source: string,
    location: string,
    observations: StationDailyObservation[],
    station: unknown,
  ) {
    if (
      !source ||
      !location ||
      !Array.isArray(observations) ||
      observations.length < 1 ||
      observations.length > 100
    ) {
      throw new BadRequestException('Provide 1-100 daily station measurements');
    }
    for (const o of observations) {
      const today = weatherDate(new Date());
      if (
        !o ||
        !validWeatherDate(o.date) ||
        o.date >= today ||
        Date.parse(o.date) < Date.parse(today) - 30 * 24 * HOUR_MS ||
        !STATION_DAILY_METRICS.includes(o.metric) ||
        typeof o.value !== 'number' ||
        !Number.isFinite(o.value) ||
        (o.metric.startsWith('temperature_')
          ? o.value < -100 || o.value > 70
          : o.value < 0 || o.value > 1000)
      ) {
        throw new BadRequestException('Invalid daily station measurement');
      }
      if (o.periodBasis === 'local-calendar-day') {
        const window = weatherDayWindow(o.date);
        if (
          o.timezone !== WEATHER_TIMEZONE ||
          !o.periodReference?.trim() ||
          o.startsAt !== window.startsAt.toISOString() ||
          o.endsAt !== window.endsAt.toISOString() ||
          window.endsAt > new Date()
        ) {
          throw new BadRequestException(
            'Daily reporting period requires verified, closed local-day boundaries',
          );
        }
      } else if (
        o.periodBasis !== 'unverified' ||
        o.startsAt !== null ||
        o.endsAt !== null ||
        o.periodReference !== null
      ) {
        throw new BadRequestException(
          'Unverified station reports cannot have invented measurement boundaries',
        );
      }
    }
    const client = await this.pool.connect();
    let recorded = 0;
    try {
      await client.query('BEGIN');
      for (const o of observations) {
        const result = await client.query(
          `INSERT INTO weather_station_daily_observations
          (location,source,report_date,metric,value,timezone,period_basis,starts_at,ends_at,period_reference,source_snapshot)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
          ON CONFLICT(location,source,report_date,metric) DO NOTHING RETURNING id`,
          [
            location,
            source,
            o.date,
            o.metric,
            o.value,
            o.timezone,
            o.periodBasis,
            o.startsAt,
            o.endsAt,
            o.periodReference,
            JSON.stringify({ station, original: o.original, modelFill: false }),
          ],
        );
        if (!result.rowCount) {
          const previous = await client.query(
            `SELECT value FROM weather_station_daily_observations
            WHERE location=$1 AND source=$2 AND report_date=$3 AND metric=$4`,
            [location, source, o.date, o.metric],
          );
          if (previous.rows[0]?.value !== o.value)
            throw new BadRequestException(DAILY_REVISION_MESSAGE);
        }
        recorded += result.rowCount ?? 0;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { recorded };
  }
}
