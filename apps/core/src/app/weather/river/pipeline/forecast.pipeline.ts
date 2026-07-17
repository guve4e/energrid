import { Injectable } from '@nestjs/common';

@Injectable()
export class ForecastPipeline {

  async execute(input: {

    signals: any[];

  }) {

    const result: {
      score: number;
      reasons: string[];
    } = {
      score: 0,
      reasons: [],
    };

    for (const signal of input.signals) {

      if (!signal) continue;

      result.score += signal.score ?? 0;

      if (signal.reason) {

        result.reasons.push(signal.reason);

      }

    }

    return result;

  }

}
