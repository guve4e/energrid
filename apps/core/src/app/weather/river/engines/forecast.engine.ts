import { Injectable } from '@nestjs/common';
import { UpstreamTrendSignal } from './signals/upstream-trend.signal';

@Injectable()
export class ForecastEngine {

  private readonly upstreamSignal =
    new UpstreamTrendSignal();
  predict(input: {
    currentCm: number;
    hours: number;
    totalChange: number;
    points: number;
    change24hCm: number | null;

    upstreamTrend?: string;
    upstreamDischarge?: number | null;
    downstreamTrend?: string;

    rainfall24hMm?: number | null;

    historicalConfidence?: number;
  }) {
    const {
      currentCm,
      hours,
      totalChange,
      points,
      change24hCm,
    } = input;

    const rateCmPerHour =
      hours > 0 ? totalChange / hours : 0;

    let trend: 'rising' | 'falling' | 'stable' | 'unknown' =
      'stable';

    const upstream =
      this.upstreamSignal.evaluate({
        upstreamTrend: input.upstreamTrend,
      });

    const signal =
      (change24hCm ?? totalChange) +
      upstream.score * 2;

    if (signal >= 3) trend = 'rising';
    else if (signal <= -3) trend = 'falling';
    else if (points < 2) trend = 'unknown';

    const confidence =
      points >= 24
        ? 'high'
        : points >= 6
          ? 'medium'
          : 'low';

    const projected6h =
      currentCm + rateCmPerHour * 6;

    const projected24h =
      currentCm + rateCmPerHour * 24;

    const direction =
      projected24h > currentCm + 2
        ? 'rising'
        : projected24h < currentCm - 2
          ? 'falling'
          : 'stable';

    const uncertainty =
      confidence === 'high'
        ? 3
        : confidence === 'medium'
          ? 6
          : 10;

    return {
      trend,
      confidence,
      rateCmPerHour: Number(
        rateCmPerHour.toFixed(2),
      ),
      projection: {
        next6h: {
          expectedCm: Math.round(projected6h),
          minCm: Math.round(projected6h - uncertainty),
          maxCm: Math.round(projected6h + uncertainty),
          direction,
        },
        next24h: {
          expectedCm: Math.round(projected24h),
          minCm: Math.round(projected24h - uncertainty),
          maxCm: Math.round(projected24h + uncertainty),
          direction,
        },
      },
    };
  }
}
