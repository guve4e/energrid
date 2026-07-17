import { Inject, Injectable, Logger } from '@nestjs/common';

import { Pool } from 'pg';

import { PG_POOL } from '../../../db.module';

type ForecastDirection = 'rising' | 'falling' | 'stable' | 'unknown';

type ForecastConfidence = 'high' | 'medium' | 'low';

interface ProjectionWindow {
  expectedCm: number;
  minCm?: number | null;
  maxCm?: number | null;
  direction?: string | null;
}

interface RiverForecastDashboard {
  mainStation?: {
    station?: string;
    levelCm?: number | null;
    fetchedAt?: string | Date | null;
    difference24hCm?: number | null;
    dischargeM3s?: number | null;
    waterTempC?: number | null;
    provider?: string | null;
  } | null;

  forecast?: {
    trend?: string | null;
    confidence?: string | null;
    rateCmPerHour?: number | null;

    projection?: {
      next6h?: ProjectionWindow | null;
      next24h?: ProjectionWindow | null;
    } | null;
  } | null;

  confidence?: {
    score?: number | null;
    confidence?: string | null;
    reasons?: string[];
    signals?: Record<string, unknown>;
  } | null;

  analogues?: unknown;
  regionalPropagationForecast?: unknown;
  propagation?: unknown;
}

@Injectable()
export class RiverForecastRecorderService {
  private readonly logger = new Logger(RiverForecastRecorderService.name);

  private readonly modelVersion = 'vidin-local-linear-v1';

  constructor(
    @Inject(PG_POOL)
    private readonly pool: Pool,
  ) {}

  async recordDashboardForecasts(dashboard: RiverForecastDashboard) {
    const main = dashboard.mainStation;

    const forecast = dashboard.forecast;

    if (
      !main ||
      main.levelCm == null ||
      !main.fetchedAt ||
      !forecast?.projection
    ) {
      this.logger.warn(
        'Forecast recording skipped: missing station, reading timestamp, level, or projection.',
      );

      return {
        recorded: 0,
        skipped: true,
        reason: 'missing-forecast-data',
      };
    }

    const issuedAt = new Date(main.fetchedAt);

    if (Number.isNaN(issuedAt.getTime())) {
      this.logger.warn(
        'Forecast recording skipped: invalid station reading timestamp.',
      );

      return {
        recorded: 0,
        skipped: true,
        reason: 'invalid-issued-at',
      };
    }

    const station = main.station?.trim() || 'Vidin';

    const confidence = this.resolveConfidence(dashboard);

    const confidenceScore =
      dashboard.confidence?.score == null
        ? null
        : Number(dashboard.confidence.score);

    const horizons = [
      {
        hours: 6,
        projection: forecast.projection.next6h,
      },
      {
        hours: 24,
        projection: forecast.projection.next24h,
      },
    ].filter(
      (
        item,
      ): item is {
        hours: number;
        projection: ProjectionWindow;
      } =>
        item.projection != null &&
        Number.isFinite(Number(item.projection.expectedCm)),
    );

    if (!horizons.length) {
      this.logger.warn(
        'Forecast recording skipped: no valid forecast horizons.',
      );

      return {
        recorded: 0,
        skipped: true,
        reason: 'missing-horizons',
      };
    }

    const inputSnapshot = {
      sourceReading: {
        station,
        levelCm: Number(main.levelCm),

        difference24hCm:
          main.difference24hCm == null ? null : Number(main.difference24hCm),

        dischargeM3s:
          main.dischargeM3s == null ? null : Number(main.dischargeM3s),

        waterTempC: main.waterTempC == null ? null : Number(main.waterTempC),

        provider: main.provider ?? null,

        fetchedAt: issuedAt.toISOString(),
      },

      localForecast: {
        trend: forecast.trend ?? 'unknown',

        confidence: forecast.confidence ?? 'low',

        rateCmPerHour: forecast.rateCmPerHour ?? null,
      },

      overallConfidence: dashboard.confidence ?? null,

      analogues: dashboard.analogues ?? null,

      regionalPropagationForecast:
        dashboard.regionalPropagationForecast ?? null,

      propagation: dashboard.propagation ?? null,
    };

    let recorded = 0;
    let duplicates = 0;

    for (const horizon of horizons) {
      const targetAt = new Date(
        issuedAt.getTime() + horizon.hours * 60 * 60 * 1000,
      );

      const result = await this.pool.query(
        `
          INSERT INTO river_forecasts (
            station,
            model_version,
            issued_at,
            target_at,
            horizon_hours,
            observed_level_at_issue,
            predicted_level,
            predicted_min,
            predicted_max,
            predicted_direction,
            confidence,
            confidence_score,
            input_snapshot
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12,
            $13::jsonb
          )
          ON CONFLICT (
            station,
            model_version,
            issued_at,
            horizon_hours
          )
          DO NOTHING
          RETURNING id
          `,
        [
          station,
          this.modelVersion,
          issuedAt,
          targetAt,
          horizon.hours,
          Number(main.levelCm),
          Number(horizon.projection.expectedCm),

          this.optionalNumber(horizon.projection.minCm),

          this.optionalNumber(horizon.projection.maxCm),

          this.resolveDirection(horizon.projection, forecast.trend),

          confidence,
          confidenceScore,

          JSON.stringify(inputSnapshot),
        ],
      );

      if (result.rowCount) {
        recorded += 1;
      } else {
        duplicates += 1;
      }
    }

    this.logger.log(
      [
        `Forecast recording complete for ${station}`,
        `issuedAt=${issuedAt.toISOString()}`,
        `recorded=${recorded}`,
        `duplicates=${duplicates}`,
      ].join(' '),
    );

    return {
      station,
      modelVersion: this.modelVersion,
      issuedAt: issuedAt.toISOString(),
      recorded,
      duplicates,
      skipped: false,
    };
  }

  private resolveConfidence(
    dashboard: RiverForecastDashboard,
  ): ForecastConfidence {
    const value =
      dashboard.confidence?.confidence ??
      dashboard.forecast?.confidence ??
      'low';

    if (value === 'high' || value === 'medium' || value === 'low') {
      return value;
    }

    return 'low';
  }

  private resolveDirection(
    projection: ProjectionWindow,
    fallback: string | null | undefined,
  ): ForecastDirection {
    const value = projection.direction ?? fallback ?? 'unknown';

    if (
      value === 'rising' ||
      value === 'falling' ||
      value === 'stable' ||
      value === 'unknown'
    ) {
      return value;
    }

    return 'unknown';
  }

  private optionalNumber(value: number | null | undefined): number | null {
    if (value == null) {
      return null;
    }

    const numeric = Number(value);

    return Number.isFinite(numeric) ? numeric : null;
  }
}
