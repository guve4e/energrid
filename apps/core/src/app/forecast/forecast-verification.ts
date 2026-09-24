/** Bias convention throughout the app: observed minus predicted. */
export function scoreForecast(predicted: number, actual: number, min?: number | null, max?: number | null) {
  if (!Number.isFinite(predicted) || !Number.isFinite(actual)) throw new Error('Forecast scores require finite values');
  if (min != null && max != null && (!Number.isFinite(min) || !Number.isFinite(max) || min > max)) {
    throw new Error('Invalid prediction range');
  }
  const signedError = actual - predicted;
  return { signedError, absoluteError: Math.abs(signedError), squaredError: signedError ** 2,
    rangeHit: min == null || max == null ? null : actual >= min && actual <= max };
}

export function riverDirection(change: number): 'rising' | 'falling' | 'stable' {
  return change >= 2 ? 'rising' : change <= -2 ? 'falling' : 'stable';
}

export function brierScore(probability: number, occurred: boolean) {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('Invalid probability');
  return (probability - Number(occurred)) ** 2;
}
