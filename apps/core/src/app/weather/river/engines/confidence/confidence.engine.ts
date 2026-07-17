import { Injectable } from '@nestjs/common';

@Injectable()
export class ConfidenceEngine {

  evaluate(input: {

    historyPoints: number;

    analogueScore?: number;

    upstreamAgreement?: boolean;

    rainfallAvailable?: boolean;

  }) {

    let score = 0;

    const reasons: string[] = [];

    if (input.historyPoints >= 24) {

      score += 30;

      reasons.push(
        'Sufficient historical observations.',
      );

    }

    if (
      input.analogueScore != null &&
      input.analogueScore < 10
    ) {

      score += 30;

      reasons.push(
        'Strong historical analogue.',
      );

    }

    if (input.upstreamAgreement) {

      score += 25;

      reasons.push(
        'Upstream stations agree.',
      );

    }

    if (input.rainfallAvailable) {

      score += 15;

      reasons.push(
        'Rainfall forecast available.',
      );

    }

    return {

      score,

      confidence:

        score >= 80

          ? 'high'

          : score >= 50

            ? 'medium'

            : 'low',

      reasons,

    };

  }

}
