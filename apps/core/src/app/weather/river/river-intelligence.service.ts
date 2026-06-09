import { Injectable } from '@nestjs/common';
import { RiverStationReading } from './river.types';
import { NormalizedRiverStation } from './river-station-normalizer.service';

@Injectable()
export class RiverIntelligenceService {
  analyze(
    mainStation: RiverStationReading | null,
    normalizedStations: NormalizedRiverStation[],
    historyTrend: any,
  ) {
    if (!mainStation) {
      return {
        mainStation: null,
        nearbyStations: [],
        intelligence: {
          headline: 'River data unavailable',
          navigationRisk: 'unknown',
          boatRisk: 'unknown',
          next24h: 'unknown',
          confidence: 'low',
          history: historyTrend,
          reasons: ['No local river station available.'],
        },
      };
    }

    const predictiveStations = normalizedStations.filter(
      (s) => s.role === 'far-upstream' || s.role === 'upstream',
    );

    const downstreamStations = normalizedStations.filter(
      (s) => s.role === 'downstream',
    );

    const predictiveTrend = this.groupTrend(predictiveStations);
    const downstreamTrend = this.groupTrend(downstreamStations);

    const localDelta = mainStation.difference24hCm ?? 0;
    const localTrend = mainStation.trend ?? 'stable';

    const prediction = this.predict(localTrend, predictiveTrend, localDelta, historyTrend);

    const boatRisk =
      prediction === 'rising-fast'
        ? 'watch'
        : prediction === 'rising'
          ? 'monitor'
          : 'normal';

    const navigationRisk =
      prediction === 'rising-fast'
        ? 'watch'
        : localDelta <= -30
          ? 'low-water'
          : 'low';

    const reasons = [
      `Vidin: ${mainStation.levelCm ?? '--'} cm, ${localTrend}, 24h ${localDelta} cm.`,
      `DB history: ${this.historyReason(historyTrend)}.`,
      `Predictive upstream chain: ${predictiveTrend}.`,
      `Downstream context only: ${downstreamTrend}.`,
    ];

    if (prediction === 'rising-fast') {
      reasons.push('Upstream/local signals suggest a stronger pulse may affect Vidin.');
    }

    return {
      mainStation,
      nearbyStations: normalizedStations.map((s) => s.bestReading).filter(Boolean),

      intelligence: {
        headline: this.headline(prediction, historyTrend),
        navigationRisk,
        boatRisk,
        next24h: prediction,
        confidence: this.confidence(predictiveStations.length, historyTrend),
        history: historyTrend,
        reasons,
      },
    };
  }

  private groupTrend(stations: NormalizedRiverStation[]): string {
    let rising = 0;
    let falling = 0;
    let steady = 0;

    for (const station of stations) {
      const reading = station.bestReading;
      if (!reading) continue;

      const delta = reading.difference24hCm;

      if (delta != null) {
        if (delta >= 10) rising++;
        else if (delta <= -10) falling++;
        else steady++;
        continue;
      }

      if (reading.trend === 'rising') rising++;
      else if (reading.trend === 'falling') falling++;
      else steady++;
    }

    if (rising > falling && rising >= 2) return 'rising';
    if (falling > rising && falling >= 2) return 'falling';

    return 'mixed';
  }

  private predict(
    localTrend: string,
    predictiveTrend: string,
    localDelta: number,
    historyTrend: any,
  ): string {
    if (predictiveTrend === 'rising' && localDelta >= 15) return 'rising-fast';
    if (predictiveTrend === 'rising') return 'rising';

    if (historyTrend?.historyTrend === 'falling' && localTrend === 'falling') {
      return 'falling';
    }

    if (historyTrend?.historyTrend === 'rising') {
      return 'rising';
    }

    if (localTrend === 'falling' && predictiveTrend === 'falling') return 'falling';

    return 'stable';
  }

  private headline(prediction: string, historyTrend: any): string {
    if (prediction === 'rising-fast') return 'Upstream pulse detected';
    if (prediction === 'rising') return 'River may rise';
    if (prediction === 'falling') return 'Falling slowly';

    if (historyTrend?.last24hChangeCm < 0 && historyTrend?.last6hChangeCm === 0) {
      return 'Falling has flattened';
    }

    return 'Stable conditions';
  }

  private confidence(predictiveStationCount: number, historyTrend: any): string {
    if (predictiveStationCount >= 5 && historyTrend?.points >= 12) return 'high';
    if (predictiveStationCount >= 2 || historyTrend?.points >= 6) return 'medium';
    return 'low';
  }

  private historyReason(historyTrend: any): string {
    if (!historyTrend || historyTrend.historyTrend === 'unknown') {
      return 'not enough history yet';
    }

    return `24h ${historyTrend.last24hChangeCm ?? '--'} cm, 12h ${
      historyTrend.last12hChangeCm ?? '--'
    } cm, 6h ${historyTrend.last6hChangeCm ?? '--'} cm, ${historyTrend.historyTrend}`;
  }
}
