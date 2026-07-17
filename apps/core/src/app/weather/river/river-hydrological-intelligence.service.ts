import { Injectable } from '@nestjs/common';
import { AppdDanubeProviderService } from './appd-danube-provider.service';
import {
  RiverHistoricalAssessment,
  RiverHistoricalContext,
  RiverHistoricalContextService,
  RiverHistoricalMetric,
} from './river-historical-context.service';
import { RiverStationReading } from './river.types';

type HydrologicalStatus =
  | 'severe-hydrological-stress'
  | 'low-flow-stress'
  | 'high-water-stress'
  | 'thermal-stress'
  | 'normal'
  | 'mixed'
  | 'unavailable';

type Confidence = 'low' | 'medium' | 'high';

interface MetricReference {
  station: string;
  currentValue: number | null;
  unit: string;
  historical: RiverHistoricalContext | null;
}

interface RegionalMetricContext {
  metric: RiverHistoricalMetric;
  unit: string;
  assessment: RiverHistoricalAssessment | 'mixed' | 'unavailable';
  confidence: Confidence;
  seasonalPercentileRange: {
    minimum: number | null;
    maximum: number | null;
  };
  references: {
    upstream: MetricReference;
    downstream: MetricReference;
  };
  headline: string;
  reasons: string[];
}

export interface VidinHydrologicalContext {
  station: 'Vidin';
  observedAt: string;
  current: {
    waterLevelCm: number | null;
    dischargeM3s: number | null;
    waterTemperatureC: number | null;
    difference24hCm: number | null;
    trend: string;
  };
  metrics: {
    waterLevel: RegionalMetricContext;
    discharge: RegionalMetricContext;
    waterTemperature: RegionalMetricContext;
  };
  combined: {
    status: HydrologicalStatus;
    confidence: Confidence;
    headline: string;
    summary: string;
    drivers: string[];
    cautions: string[];
  };
  disclaimer: string;
}

@Injectable()
export class RiverHydrologicalIntelligenceService {
  constructor(
    private readonly appd: AppdDanubeProviderService,
    private readonly historical: RiverHistoricalContextService,
  ) {}

  async getVidinContext(
    observedAt = new Date(),
  ): Promise<VidinHydrologicalContext> {
    const readings = await this.appd.getStations();

    const novoSelo = this.findStation(readings, 'novo selo');
    const vidin = this.findStation(readings, 'vidin');
    const lom = this.findStation(readings, 'lom');

    const [waterLevel, discharge, waterTemperature] = await Promise.all([
      this.buildRegionalMetric('water_level', 'cm', novoSelo, lom, observedAt),
      this.buildRegionalMetric(
        'water_discharge',
        'm3/s',
        novoSelo,
        lom,
        observedAt,
      ),
      this.buildRegionalMetric(
        'water_temperature',
        'C',
        novoSelo,
        lom,
        observedAt,
      ),
    ]);

    const combined = this.combine(waterLevel, discharge, waterTemperature);

    return {
      station: 'Vidin',
      observedAt: observedAt.toISOString(),
      current: {
        waterLevelCm: vidin?.levelCm ?? null,
        dischargeM3s: vidin?.dischargeM3s ?? null,
        waterTemperatureC: vidin?.waterTempC ?? null,
        difference24hCm: vidin?.difference24hCm ?? null,
        trend: vidin?.trend ?? 'unknown',
      },
      metrics: {
        waterLevel,
        discharge,
        waterTemperature,
      },
      combined,
      disclaimer:
        'Vidin has no published long-term APPD archive. Historical classifications use Novo Selo and Lom as upstream and downstream references. Gauge levels are compared only with each station’s own historical record.',
    };
  }

  private async buildRegionalMetric(
    metric: RiverHistoricalMetric,
    unit: string,
    upstreamReading: RiverStationReading | null,
    downstreamReading: RiverStationReading | null,
    observedAt: Date,
  ): Promise<RegionalMetricContext> {
    const upstreamValue = this.metricValue(metric, upstreamReading);
    const downstreamValue = this.metricValue(metric, downstreamReading);

    const [upstreamHistorical, downstreamHistorical] = await Promise.all([
      upstreamValue == null
        ? Promise.resolve(null)
        : this.historical.getContext(
            'novo-selo',
            metric,
            upstreamValue,
            observedAt,
          ),
      downstreamValue == null
        ? Promise.resolve(null)
        : this.historical.getContext(
            'lom',
            metric,
            downstreamValue,
            observedAt,
          ),
    ]);

    const upstream: MetricReference = {
      station: 'Novo Selo',
      currentValue: upstreamValue,
      unit,
      historical: upstreamHistorical,
    };

    const downstream: MetricReference = {
      station: 'Lom',
      currentValue: downstreamValue,
      unit,
      historical: downstreamHistorical,
    };

    return this.assessMetric(metric, unit, upstream, downstream);
  }

  private assessMetric(
    metric: RiverHistoricalMetric,
    unit: string,
    upstream: MetricReference,
    downstream: MetricReference,
  ): RegionalMetricContext {
    const contexts = [upstream.historical, downstream.historical].filter(
      (context): context is RiverHistoricalContext => context !== null,
    );

    if (contexts.length === 0) {
      return {
        metric,
        unit,
        assessment: 'unavailable',
        confidence: 'low',
        seasonalPercentileRange: {
          minimum: null,
          maximum: null,
        },
        references: {
          upstream,
          downstream,
        },
        headline: `${this.metricLabel(metric)} context unavailable`,
        reasons: [
          'No current values could be compared with the historical archives.',
        ],
      };
    }

    const percentiles = contexts.map((context) => context.seasonal.percentile);

    const minimum = Math.min(...percentiles);
    const maximum = Math.max(...percentiles);
    const spread = maximum - minimum;

    const assessments = contexts.map((context) => context.assessment);

    const sameDirection = this.sameDirection(assessments);

    let assessment: RiverHistoricalAssessment | 'mixed' | 'unavailable';

    if (!sameDirection || spread > 30) {
      assessment = 'mixed';
    } else {
      assessment = this.conservativeAssessment(metric, contexts);
    }

    return {
      metric,
      unit,
      assessment,
      confidence:
        contexts.length === 2 && spread <= 10
          ? 'high'
          : contexts.length === 2
            ? 'medium'
            : 'low',
      seasonalPercentileRange: {
        minimum,
        maximum,
      },
      references: {
        upstream,
        downstream,
      },
      headline: this.metricHeadline(metric, assessment),
      reasons: contexts.map((context) => this.contextReason(context)),
    };
  }

  private conservativeAssessment(
    metric: RiverHistoricalMetric,
    contexts: RiverHistoricalContext[],
  ): RiverHistoricalAssessment {
    /*
     * Both stations must support the severity.
     *
     * For low conditions, use the higher percentile.
     * For high conditions, use the lower percentile.
     */
    const percentiles = contexts.map((context) => context.seasonal.percentile);

    const allLow = contexts.every(
      (context) => this.direction(context.assessment) === 'low',
    );

    const allHigh = contexts.every(
      (context) => this.direction(context.assessment) === 'high',
    );

    if (allLow) {
      const conservative = Math.max(...percentiles);

      if (conservative <= 0) return 'record-low';
      if (conservative <= 1) return 'exceptionally-low';
      if (conservative <= 15) return 'below-normal';

      return 'normal';
    }

    if (allHigh) {
      const conservative = Math.min(...percentiles);

      if (conservative >= 100) return 'record-high';
      if (conservative >= 99) return 'exceptionally-high';
      if (conservative >= 85) return 'above-normal';

      return 'normal';
    }

    /*
     * Temperature can be normal while levels are low, and vice versa.
     * This fallback uses the first context only when both stations agree
     * directionally but occupy slightly different severity bands.
     */
    return contexts[0].assessment;
  }

  private combine(
    level: RegionalMetricContext,
    discharge: RegionalMetricContext,
    temperature: RegionalMetricContext,
  ): VidinHydrologicalContext['combined'] {
    const levelLow = this.isLow(level.assessment);
    const dischargeLow = this.isLow(discharge.assessment);
    const temperatureHigh = this.isHigh(temperature.assessment);

    const levelHigh = this.isHigh(level.assessment);
    const dischargeHigh = this.isHigh(discharge.assessment);

    const drivers: string[] = [];

    if (level.assessment !== 'unavailable') {
      drivers.push(`Water level: ${this.formatAssessment(level.assessment)}.`);
    }

    if (discharge.assessment !== 'unavailable') {
      drivers.push(
        `Discharge: ${this.formatAssessment(discharge.assessment)}.`,
      );
    }

    if (temperature.assessment !== 'unavailable') {
      drivers.push(
        `Water temperature: ${this.formatAssessment(temperature.assessment)}.`,
      );
    }

    if (levelLow && dischargeLow && temperatureHigh) {
      return {
        status: 'severe-hydrological-stress',
        confidence: this.combinedConfidence([level, discharge, temperature]),
        headline: 'Extreme low-flow and heat-stress regime',
        summary:
          'Regional water levels and discharge are historically low while water temperatures are historically high. Together, these signals indicate severe hydrological stress in the Vidin Danube corridor.',
        drivers,
        cautions: [
          'Low water can reduce available navigation depth.',
          'Low discharge indicates reduced river flow, not only a low gauge reading.',
          'High water temperature can increase ecological stress and reduce dissolved oxygen.',
        ],
      };
    }

    if (levelLow && dischargeLow) {
      return {
        status: 'low-flow-stress',
        confidence: this.combinedConfidence([level, discharge]),
        headline: 'Exceptional low-flow regime',
        summary:
          'Both regional water levels and discharge are historically low, indicating a genuine low-flow event rather than an isolated gauge anomaly.',
        drivers,
        cautions: [
          'Navigation depth may be restricted.',
          'Conditions may continue worsening if the falling trend persists.',
        ],
      };
    }

    if (levelHigh && dischargeHigh) {
      return {
        status: 'high-water-stress',
        confidence: this.combinedConfidence([level, discharge]),
        headline: 'Elevated high-water regime',
        summary:
          'Regional water levels and discharge are both historically elevated.',
        drivers,
        cautions: ['Monitor flood and navigation advisories.'],
      };
    }

    if (temperatureHigh) {
      return {
        status: 'thermal-stress',
        confidence: temperature.confidence,
        headline: 'Historically high water temperature',
        summary:
          'Water temperature is unusually high for the season, creating potential ecological stress even without an extreme level or discharge signal.',
        drivers,
        cautions: ['Warm water may reduce dissolved oxygen.'],
      };
    }

    const unavailableCount = [level, discharge, temperature].filter(
      (item) => item.assessment === 'unavailable',
    ).length;

    if (unavailableCount === 3) {
      return {
        status: 'unavailable',
        confidence: 'low',
        headline: 'Hydrological context unavailable',
        summary:
          'There is not enough current data to produce a combined historical assessment.',
        drivers,
        cautions: [],
      };
    }

    const mixed = [level, discharge, temperature].some(
      (item) => item.assessment === 'mixed',
    );

    return {
      status: mixed ? 'mixed' : 'normal',
      confidence: this.combinedConfidence([level, discharge, temperature]),
      headline: mixed
        ? 'Mixed hydrological signal'
        : 'Hydrological conditions within seasonal ranges',
      summary: mixed
        ? 'The three hydrological metrics do not currently support one consistent regional classification.'
        : 'Water level, discharge, and temperature remain broadly within their historical seasonal ranges.',
      drivers,
      cautions: [],
    };
  }

  private metricValue(
    metric: RiverHistoricalMetric,
    reading: RiverStationReading | null,
  ): number | null {
    if (!reading) return null;

    switch (metric) {
      case 'water_level':
        return reading.levelCm;
      case 'water_discharge':
        return reading.dischargeM3s;
      case 'water_temperature':
        return reading.waterTempC;
    }
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

  private sameDirection(assessments: RiverHistoricalAssessment[]): boolean {
    const directions = new Set(
      assessments.map((assessment) => this.direction(assessment)),
    );

    return directions.size === 1;
  }

  private direction(
    assessment: RiverHistoricalAssessment,
  ): 'low' | 'normal' | 'high' {
    if (this.isLow(assessment)) return 'low';
    if (this.isHigh(assessment)) return 'high';
    return 'normal';
  }

  private isLow(
    assessment: RiverHistoricalAssessment | 'mixed' | 'unavailable',
  ): boolean {
    return [
      'record-low',
      'near-record-low',
      'exceptionally-low',
      'below-normal',
    ].includes(assessment);
  }

  private isHigh(
    assessment: RiverHistoricalAssessment | 'mixed' | 'unavailable',
  ): boolean {
    return [
      'record-high',
      'near-record-high',
      'exceptionally-high',
      'above-normal',
    ].includes(assessment);
  }

  private combinedConfidence(metrics: RegionalMetricContext[]): Confidence {
    if (metrics.every((metric) => metric.confidence === 'high')) {
      return 'high';
    }

    if (metrics.some((metric) => metric.confidence === 'low')) {
      return 'low';
    }

    return 'medium';
  }

  private metricHeadline(
    metric: RiverHistoricalMetric,
    assessment: RiverHistoricalAssessment | 'mixed' | 'unavailable',
  ): string {
    return `${this.metricLabel(metric)}: ${this.formatAssessment(assessment)}`;
  }

  private metricLabel(metric: RiverHistoricalMetric): string {
    switch (metric) {
      case 'water_level':
        return 'Water level';
      case 'water_discharge':
        return 'Discharge';
      case 'water_temperature':
        return 'Water temperature';
    }
  }

  private contextReason(context: RiverHistoricalContext): string {
    const difference = context.currentValue - context.seasonal.median;

    return (
      `${context.station}: ${context.currentValue} ${context.unit}, ` +
      `${this.round(context.seasonal.percentile)} seasonal percentile, ` +
      `${this.formatSigned(difference)} ${context.unit} versus the monthly median, ` +
      `${this.formatAssessment(context.assessment)}.`
    );
  }

  private formatAssessment(
    assessment: RiverHistoricalAssessment | 'mixed' | 'unavailable',
  ): string {
    return assessment.replaceAll('-', ' ');
  }

  private round(value: number): number {
    return Math.round(value * 10) / 10;
  }

  private formatSigned(value: number): string {
    const rounded = this.round(value);

    return rounded > 0 ? `+${rounded}` : String(rounded);
  }
}
