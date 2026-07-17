export interface ForecastResult {
  expected: number;
  actual: number;
}

export class BacktestEngine {

  evaluate(results: ForecastResult[]) {

    if (!results.length) {
      return {
        mae: null,
        bias: null,
      };
    }

    let absoluteError = 0;
    let signedError = 0;

    for (const result of results) {

      const error =
        result.expected - result.actual;

      absoluteError += Math.abs(error);

      signedError += error;
    }

    return {

      mae:
        absoluteError / results.length,

      bias:
        signedError / results.length,

    };
  }

}
