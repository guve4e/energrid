import { ForecastSignal } from './forecast-signal';

export class UpstreamTrendSignal {
  evaluate(input: {
    upstreamTrend?: string;
  }): ForecastSignal {

    switch (input.upstreamTrend) {

      case 'rising':
        return {
          name: 'upstream-trend',
          score: 1,
          confidence: 0.8,
          explanation:
            'Upstream stations are rising.',
        };

      case 'falling':
        return {
          name: 'upstream-trend',
          score: -1,
          confidence: 0.8,
          explanation:
            'Upstream stations are falling.',
        };

      default:
        return {
          name: 'upstream-trend',
          score: 0,
          confidence: 0.2,
          explanation:
            'No clear upstream trend.',
        };
    }
  }
}
