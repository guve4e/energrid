import {
  DailyPropagationEngine,
} from './daily-propagation.engine';

import {
  NOVO_SELO_TO_LOM_DAILY_MODEL,
} from './validated-propagation.models';

describe('DailyPropagationEngine', () => {
  let engine: DailyPropagationEngine;

  beforeEach(() => {
    engine =
      new DailyPropagationEngine();
  });

  it('predicts a falling Lom response from falling Novo Selo', () => {
    const result = engine.predict(
      NOVO_SELO_TO_LOM_DAILY_MODEL,
      {
        upstreamDelta24hCm: -8,
        downstreamDelta24hCm: -5,
        downstreamCurrentLevelCm: 29,
      },
    );

    expect(
      result.predictedDelta24hCm,
    ).toBe(-4.5);

    expect(result.direction).toBe(
      'falling',
    );

    expect(
      result.expectedLevelCm,
    ).toBe(24.5);
  });

  it('predicts a rising response from a strong upstream rise', () => {
    const result = engine.predict(
      NOVO_SELO_TO_LOM_DAILY_MODEL,
      {
        upstreamDelta24hCm: 20,
        downstreamDelta24hCm: 3,
        downstreamCurrentLevelCm: 100,
      },
    );

    expect(
      result.predictedDelta24hCm,
    ).toBeGreaterThan(10);

    expect(result.direction).toBe(
      'rising',
    );
  });

  it('does not invent an expected level when the current level is absent', () => {
    const result = engine.predict(
      NOVO_SELO_TO_LOM_DAILY_MODEL,
      {
        upstreamDelta24hCm: -5,
        downstreamDelta24hCm: -2,
      },
    );

    expect(
      result.expectedLevelCm,
    ).toBeNull();
  });

  it('exposes validation evidence with the prediction', () => {
    const result = engine.predict(
      NOVO_SELO_TO_LOM_DAILY_MODEL,
      {
        upstreamDelta24hCm: 0,
        downstreamDelta24hCm: 0,
      },
    );

    expect(
      result.validation.periods,
    ).toHaveLength(4);

    expect(
      result.validation
        .upstreamValueAddedRangePct
        .minimum,
    ).toBe(17.8);
  });
});
