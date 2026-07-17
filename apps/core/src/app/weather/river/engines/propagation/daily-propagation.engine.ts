export type PropagationDirection =
  | 'rising'
  | 'falling'
  | 'stable';

export interface DailyPropagationModel {
  upstreamStation: string;
  downstreamStation: string;

  intercept: number;
  localWeight: number;
  upstreamWeight: number;

  lagDays: number;

  validation: {
    periods: string[];
    maeRangeCm: {
      minimum: number;
      maximum: number;
    };
    directionAccuracyRangePct: {
      minimum: number;
      maximum: number;
    };
    upstreamValueAddedRangePct: {
      minimum: number;
      maximum: number;
    };
  };
}

export interface DailyPropagationInput {
  upstreamDelta24hCm: number;
  downstreamDelta24hCm: number;
  downstreamCurrentLevelCm?: number | null;
}

export class DailyPropagationEngine {
  predict(
    model: DailyPropagationModel,
    input: DailyPropagationInput,
  ) {
    const predictedDelta24hCm =
      model.intercept +
      model.localWeight *
        input.downstreamDelta24hCm +
      model.upstreamWeight *
        input.upstreamDelta24hCm;

    const expectedLevelCm =
      input.downstreamCurrentLevelCm == null
        ? null
        : input.downstreamCurrentLevelCm +
          predictedDelta24hCm;

    return {
      upstreamStation:
        model.upstreamStation,

      downstreamStation:
        model.downstreamStation,

      lagDays:
        model.lagDays,

      predictedDelta24hCm:
        Number(
          predictedDelta24hCm.toFixed(1),
        ),

      expectedLevelCm:
        expectedLevelCm == null
          ? null
          : Number(
              expectedLevelCm.toFixed(1),
            ),

      direction:
        this.direction(
          predictedDelta24hCm,
        ),

      inputs: {
        upstreamDelta24hCm:
          input.upstreamDelta24hCm,

        downstreamDelta24hCm:
          input.downstreamDelta24hCm,

        downstreamCurrentLevelCm:
          input.downstreamCurrentLevelCm ??
          null,
      },

      coefficients: {
        intercept:
          model.intercept,

        localWeight:
          model.localWeight,

        upstreamWeight:
          model.upstreamWeight,
      },

      validation:
        model.validation,
    };
  }

  private direction(
    deltaCm: number,
  ): PropagationDirection {
    if (deltaCm >= 2) {
      return 'rising';
    }

    if (deltaCm <= -2) {
      return 'falling';
    }

    return 'stable';
  }
}
