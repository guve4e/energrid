import { Injectable } from '@nestjs/common';
import { AppdDanubeProviderService } from './appd-danube-provider.service';
import {
  RiverHistoricalContextService,
  RiverWaterLevelHistoricalContext,
} from './river-historical-context.service';
import { RiverStationReading } from './river.types';

type RegionalAssessment =
  | 'record-low'
  | 'exceptionally-low'
  | 'below-normal'
  | 'normal'
  | 'above-normal'
  | 'exceptionally-high'
  | 'mixed'
  | 'unavailable';

type RegionalConfidence = 'low' | 'medium' | 'high';

interface RegionalStationContext {
  role: 'upstream' | 'local' | 'downstream';
  station: string;
  currentLevelCm: number | null;
  difference24hCm: number | null;
  trend: string;
  historicalArchiveAvailable: boolean;
  historical: RiverWaterLevelHistoricalContext | null;
}

export interface VidinRegionalContext {
  station: 'Vidin';
  currentLevelCm: number | null;
  difference24hCm: number | null;
  trend: string;
  historicalArchiveAvailable: false;
  referenceMonth: number;
  references: {
    upstream: RegionalStationContext;
    downstream: RegionalStationContext;
  };
  regional: {
    assessment: RegionalAssessment;
    confidence: RegionalConfidence;
    seasonalPercentileRange: {
      minimum: number | null;
      maximum: number | null;
    };
    agreement: 'strong' | 'partial' | 'divergent' | 'unavailable';
    headline: string;
    explanation: string;
    reasons: string[];
  };
  disclaimer: string;
}

@Injectable()
export class RiverRegionalIntelligenceService {
  constructor(
    private readonly appd: AppdDanubeProviderService,
    private readonly historicalContext: RiverHistoricalContextService,
  ) {}

  async getVidinContext(
    observedAt = new Date(),
  ): Promise<VidinRegionalContext> {
    const readings = await this.appd.getStations();

    const novoSelo = this.findStation(readings, 'novo selo');
    const vidin = this.findStation(readings, 'vidin');
    const lom = this.findStation(readings, 'lom');

    const [novoSeloHistorical, lomHistorical] = await Promise.all([
      this.getHistoricalContext('novo-selo', novoSelo, observedAt),
      this.getHistoricalContext('lom', lom, observedAt),
    ]);

    const regional = this.assessRegion(novoSeloHistorical, lomHistorical);

    return {
      station: 'Vidin',
      currentLevelCm: vidin?.levelCm ?? null,
      difference24hCm: vidin?.difference24hCm ?? null,
      trend: vidin?.trend ?? 'unknown',
      historicalArchiveAvailable: false,
      referenceMonth: observedAt.getUTCMonth() + 1,
      references: {
        upstream: this.toStationContext(
          'upstream',
          'Novo Selo',
          novoSelo,
          novoSeloHistorical,
        ),
        downstream: this.toStationContext(
          'downstream',
          'Lom',
          lom,
          lomHistorical,
        ),
      },
      regional,
      disclaimer:
        'Vidin has no published long-term APPD archive. The regional assessment compares Novo Selo and Lom with their own station-specific historical records. Raw gauge centimetres are not averaged because each station uses its own gauge datum.',
    };
  }

  private findStation(
    readings: RiverStationReading[],
    name: string,
  ): RiverStationReading | null {
    const normalizedName = name.toLowerCase();

    return (
      readings.find(
        (reading) => reading.station.trim().toLowerCase() === normalizedName,
      ) ??
      readings.find((reading) =>
        reading.station.toLowerCase().includes(normalizedName),
      ) ??
      null
    );
  }

  private async getHistoricalContext(
    stationCode: string,
    reading: RiverStationReading | null,
    observedAt: Date,
  ): Promise<RiverWaterLevelHistoricalContext | null> {
    if (reading?.levelCm == null) {
      return null;
    }

    return this.historicalContext.getWaterLevelContext(
      stationCode,
      reading.levelCm,
      observedAt,
    );
  }

  private toStationContext(
    role: 'upstream' | 'downstream',
    station: string,
    reading: RiverStationReading | null,
    historical: RiverWaterLevelHistoricalContext | null,
  ): RegionalStationContext {
    return {
      role,
      station,
      currentLevelCm: reading?.levelCm ?? null,
      difference24hCm: reading?.difference24hCm ?? null,
      trend: reading?.trend ?? 'unknown',
      historicalArchiveAvailable: historical !== null,
      historical,
    };
  }

  private assessRegion(
    upstream: RiverWaterLevelHistoricalContext | null,
    downstream: RiverWaterLevelHistoricalContext | null,
  ): VidinRegionalContext['regional'] {
    if (!upstream && !downstream) {
      return {
        assessment: 'unavailable',
        confidence: 'low',
        seasonalPercentileRange: {
          minimum: null,
          maximum: null,
        },
        agreement: 'unavailable',
        headline: 'Regional historical context unavailable',
        explanation:
          'Current readings could not be compared with both historical archives.',
        reasons: [
          'Novo Selo historical comparison unavailable.',
          'Lom historical comparison unavailable.',
        ],
      };
    }

    if (!upstream || !downstream) {
      const available = upstream ?? downstream;

      if (!available) {
        return {
          assessment: 'unavailable',
          confidence: 'low',
          seasonalPercentileRange: {
            minimum: null,
            maximum: null,
          },
          agreement: 'unavailable',
          headline: 'Regional historical context unavailable',
          explanation: 'Neither historical reference station was available.',
          reasons: [
            'Novo Selo comparison unavailable.',
            'Lom comparison unavailable.',
          ],
        };
      }

      const percentile = available.seasonal.percentile;
      const assessment = this.assessmentFromPercentile(percentile);

      return {
        assessment,
        confidence: 'medium',
        seasonalPercentileRange: {
          minimum: percentile,
          maximum: percentile,
        },
        agreement: 'partial',
        headline: this.headlineFromAssessment(assessment),
        explanation:
          'Only one of the two historical reference stations was available, so the regional conclusion is provisional.',
        reasons: [
          upstream
            ? this.stationReason('Novo Selo', upstream)
            : 'Novo Selo comparison unavailable.',
          downstream
            ? this.stationReason('Lom', downstream)
            : 'Lom comparison unavailable.',
        ],
      };
    }

    const upstreamPercentile = upstream.seasonal.percentile;
    const downstreamPercentile = downstream.seasonal.percentile;
    const minimum = Math.min(upstreamPercentile, downstreamPercentile);
    const maximum = Math.max(upstreamPercentile, downstreamPercentile);
    const spread = maximum - minimum;

    const agreement =
      spread <= 10 ? 'strong' : spread <= 30 ? 'partial' : 'divergent';

    if (agreement === 'divergent') {
      return {
        assessment: 'mixed',
        confidence: 'medium',
        seasonalPercentileRange: {
          minimum,
          maximum,
        },
        agreement,
        headline: 'Mixed regional river signal',
        explanation:
          'Novo Selo and Lom occupy very different historical seasonal positions. This does not support a confident region-wide classification for Vidin.',
        reasons: [
          this.stationReason('Novo Selo', upstream),
          this.stationReason('Lom', downstream),
          `Historical percentile spread is ${this.round(spread)} percentage points.`,
        ],
      };
    }

    /*
     * Use the less extreme of the two percentiles.
     *
     * Example:
     * Novo Selo = 0.4th percentile
     * Lom = 2.0th percentile
     *
     * Regional classification is based on 2.0, because both stations
     * must support the severity level. This prevents one extreme gauge
     * from overstating the regional conclusion.
     */
    const conservativePercentile = maximum;
    const assessment = this.assessmentFromPercentile(conservativePercentile);

    return {
      assessment,
      confidence: agreement === 'strong' ? 'high' : 'medium',
      seasonalPercentileRange: {
        minimum,
        maximum,
      },
      agreement,
      headline: this.headlineFromAssessment(assessment),
      explanation: this.explanationFromAssessment(
        assessment,
        minimum,
        maximum,
        upstream,
        downstream,
      ),
      reasons: [
        this.stationReason('Novo Selo', upstream),
        this.stationReason('Lom', downstream),
        `Both reference stations support the regional classification using station-specific seasonal history.`,
      ],
    };
  }

  private assessmentFromPercentile(percentile: number): RegionalAssessment {
    if (percentile <= 0) return 'record-low';
    if (percentile <= 1) return 'exceptionally-low';
    if (percentile <= 15) return 'below-normal';
    if (percentile >= 99) return 'exceptionally-high';
    if (percentile >= 85) return 'above-normal';
    return 'normal';
  }

  private headlineFromAssessment(assessment: RegionalAssessment): string {
    switch (assessment) {
      case 'record-low':
        return 'Lowest July range in the available historical archive';
      case 'exceptionally-low':
        return 'Historically exceptional low-water conditions';
      case 'below-normal':
        return 'Regional river levels are below normal';
      case 'above-normal':
        return 'Regional river levels are above normal';
      case 'exceptionally-high':
        return 'Historically exceptional high-water conditions';
      case 'normal':
        return 'Regional river levels are within the normal range';
      case 'mixed':
        return 'Mixed regional river signal';
      default:
        return 'Regional historical context unavailable';
    }
  }

  private explanationFromAssessment(
    assessment: RegionalAssessment,
    minimumPercentile: number,
    maximumPercentile: number,
    upstream: RiverWaterLevelHistoricalContext,
    downstream: RiverWaterLevelHistoricalContext,
  ): string {
    const range =
      `${this.round(minimumPercentile)}–` +
      `${this.round(maximumPercentile)} seasonal percentile`;

    switch (assessment) {
      case 'record-low':
        return (
          `Both regional reference stations are below every observation ` +
          `for this month in the available official archives (${range}). ` +
          `Novo Selo covers ${upstream.coverage.from.slice(0, 4)}–` +
          `${upstream.coverage.to.slice(0, 4)} and Lom covers ` +
          `${downstream.coverage.from.slice(0, 4)}–` +
          `${downstream.coverage.to.slice(0, 4)}.`
        );
      case 'exceptionally-low':
        return `Both regional reference stations are within the lowest 1% of observations for this month (${range}).`;
      case 'below-normal':
        return `Both regional reference stations are within the lower historical seasonal range (${range}).`;
      case 'above-normal':
        return `Both regional reference stations are within the upper historical seasonal range (${range}).`;
      case 'exceptionally-high':
        return `Both regional reference stations are within the highest 1% of observations for this month (${range}).`;
      default:
        return `Both regional reference stations are within their normal historical seasonal ranges (${range}).`;
    }
  }

  private stationReason(
    station: string,
    context: RiverWaterLevelHistoricalContext,
  ): string {
    const differenceFromMedian =
      context.currentValueCm - context.seasonal.medianCm;

    return (
      `${station}: ${context.currentValueCm} cm, ` +
      `${this.round(context.seasonal.percentile)} seasonal percentile, ` +
      `${this.formatSigned(differenceFromMedian)} cm versus the monthly median, ` +
      `${context.assessment}.`
    );
  }

  private round(value: number): number {
    return Math.round(value * 10) / 10;
  }

  private formatSigned(value: number): string {
    const rounded = this.round(value);

    return rounded > 0 ? `+${rounded}` : String(rounded);
  }
}
