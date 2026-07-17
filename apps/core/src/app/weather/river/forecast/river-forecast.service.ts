import { Injectable } from '@nestjs/common';

import { HistoricalAnalogueService } from '../analogue/historical-analogue.service';
import { ConfidenceEngine } from '../engines/confidence/confidence.engine';
import { ForecastEngine } from '../engines/forecast.engine';

interface ForecastHistoryPoint {
  fetchedAt: string | Date;
  levelCm: number;
}

interface UpstreamAnalogueInput {
  stationCode: string;
  levelCm: number;
  change24hCm: number;
  dischargeM3s?: number | null;
  waterTemperatureC?: number | null;
}

@Injectable()
export class RiverForecastService {
  constructor(
    private readonly forecastEngine: ForecastEngine,
    private readonly analogue: HistoricalAnalogueService,
    private readonly confidenceEngine: ConfidenceEngine,
  ) {}

  async generate(input: {
    station: string;
    currentCm: number;
    history: ForecastHistoryPoint[];
    change24hCm: number | null;
    upstreamTrend?: string;
    upstreamDischarge?: number | null;
    downstreamTrend?: string;
    upstreamAnalogue?: UpstreamAnalogueInput | null;
  }) {
    const orderedHistory = [...input.history].sort(
      (left, right) =>
        new Date(left.fetchedAt).getTime() -
        new Date(right.fetchedAt).getTime(),
    );

    const first = orderedHistory[0];
    const last = orderedHistory.at(-1);

    const hours =
      first && last
        ? Math.max(
            0,
            (new Date(last.fetchedAt).getTime() -
              new Date(first.fetchedAt).getTime()) /
              36e5,
          )
        : 0;

    const totalChange =
      first && last
        ? Number(last.levelCm) - Number(first.levelCm)
        : 0;

    /*
     * Vidin gauge centimetres must never be compared directly with
     * Novo Selo or Lom gauge archives. Analogues are evaluated only
     * against the matching upstream station archive.
     */
    const analogues = input.upstreamAnalogue
      ? await this.analogue.findBestMatches(
          input.upstreamAnalogue.stationCode,
          {
            level: input.upstreamAnalogue.levelCm,
            delta24h: input.upstreamAnalogue.change24hCm,
            discharge:
              input.upstreamAnalogue.dischargeM3s ?? null,
            temperature:
              input.upstreamAnalogue.waterTemperatureC ?? null,
            month: new Date().getUTCMonth() + 1,
          },
        )
      : {
          analogues: [],
          averageDelta: null,
          medianDelta: null,
          spread: null,
          direction: 'unknown' as const,
          directionalAgreement: 0,
          outcomes: {
            falling: 0,
            stable: 0,
            rising: 0,
            total: 0,
          },
          confidence: 'low' as const,
        };

    const forecast = this.forecastEngine.predict({
      currentCm: input.currentCm,
      hours,
      totalChange,
      points: orderedHistory.length,
      change24hCm: input.change24hCm,
      upstreamTrend: input.upstreamTrend,
      upstreamDischarge: input.upstreamDischarge,
      downstreamTrend: input.downstreamTrend,
      historicalConfidence:
        analogues.confidence === 'high'
          ? 1
          : analogues.confidence === 'medium'
            ? 0.6
            : 0.3,
    });

    const bestAnalogueScore =
      analogues.confidence === 'low'
        ? undefined
        : analogues.analogues?.[0]?.score;

    const directionalUpstreamSignal =
      input.upstreamTrend === 'rising' ||
      input.upstreamTrend === 'falling';

    const baseConfidence =
      this.confidenceEngine.evaluate({
        historyPoints: orderedHistory.length,
        analogueScore: bestAnalogueScore,
        upstreamAgreement: directionalUpstreamSignal,
        rainfallAvailable: false,
      });

    const analogueHasDirection =
      analogues.direction === 'rising' ||
      analogues.direction === 'falling' ||
      analogues.direction === 'stable';

    const analogueAgrees =
      analogueHasDirection &&
      analogues.direction === forecast.trend;

    const analogueReliable =
      analogues.confidence === 'high' ||
      analogues.confidence === 'medium';

    let confidenceScore =
      baseConfidence.score;

    const confidenceReasons = [
      ...baseConfidence.reasons,
    ];

    if (
      analogueAgrees &&
      analogueReliable
    ) {
      confidenceScore = Math.min(
        100,
        confidenceScore + 15,
      );

      confidenceReasons.push(
        'Reliable historical analogues agree with the forecast direction.',
      );
    } else if (analogueAgrees) {
      confidenceReasons.push(
        'Historical analogues agree on direction, but their outcome spread is wide.',
      );
    } else if (analogueHasDirection) {
      confidenceReasons.push(
        'Historical analogues do not agree with the current forecast direction.',
      );
    } else {
      confidenceReasons.push(
        'Historical analogue direction is unavailable.',
      );
    }

    const confidenceLevel =
      confidenceScore >= 80
        ? 'high'
        : confidenceScore >= 50
          ? 'medium'
          : 'low';

    return {
      forecast,
      analogues: {
        station:
          input.upstreamAnalogue?.stationCode ?? null,
        ...analogues,
      },
      confidence: {
        score: confidenceScore,
        confidence: confidenceLevel,
        reasons: confidenceReasons,
        signals: {
          analogueDirection:
            analogues.direction ?? 'unknown',
          analogueAgreement:
            analogues.directionalAgreement ?? 0,
          analogueReliable,
          analogueAgrees,
        },
      },
    };
  }
}
