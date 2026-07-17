export interface WeightedPredictionInput {
  currentCm: number;

  historicalRate: number;

  upstreamRate?: number;

  upstreamDischarge?: number | null;
}

export class WeightedPredictor {

  predict(input: WeightedPredictionInput) {

    const historical =
      input.historicalRate * 0.35;

    const upstream =
      (input.upstreamRate ?? 0) * 0.30;

    const discharge =
      input.upstreamDischarge != null
        ? ((input.upstreamDischarge - 2500) / 2500) * 0.20
        : 0;

    const local =
      input.historicalRate * 0.15;

    const delta =
      historical +
      upstream +
      discharge +
      local;

    return {
      expectedCm:
        input.currentCm + delta * 24,

      hourlyRate: delta,
    };
  }

}
