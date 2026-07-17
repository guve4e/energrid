import { TrendAnalysis } from './trend-analyzer';

export interface TravelTimeEstimate {
  hours: number;
  confidence: number;
  explanation: string;
}

export class TravelTimeSignal {

  estimate(
    upstream: TrendAnalysis,
    local: TrendAnalysis,
  ): TravelTimeEstimate {

    /*
     * Initial heuristic.
     *
     * Later this will become historical correlation.
     */

    if (
      upstream.trend === 'falling' &&
      local.trend === 'stable'
    ) {
      return {
        hours: 12,
        confidence: 0.60,
        explanation:
          'Upstream decline has not yet reached Vidin.',
      };
    }

    if (
      upstream.trend === 'rising' &&
      local.trend === 'stable'
    ) {
      return {
        hours: 12,
        confidence: 0.60,
        explanation:
          'Upstream rise is propagating downstream.',
      };
    }

    return {
      hours: 0,
      confidence: 0.80,
      explanation:
        'Vidin already reflects the upstream behaviour.',
    };
  }
}
