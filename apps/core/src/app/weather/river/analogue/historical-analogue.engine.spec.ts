import {
  HistoricalAnalogueEngine,
} from './historical-analogue.engine';

describe('HistoricalAnalogueEngine', () => {

  let engine: HistoricalAnalogueEngine;

  beforeEach(() => {
    engine = new HistoricalAnalogueEngine();
  });

  it('returns zero for identical river states', () => {

    const score = engine.score(
      {
        level: 14,
        delta24h: -5,
        discharge: 1730,
        temperature: 26.6,
      },
      {
        level: 14,
        delta24h: -5,
        discharge: 1730,
        temperature: 26.6,
      },
    );

    expect(score).toBe(0);

  });

  it('prefers the closest analogue', () => {

    const current = {
      level: 14,
      delta24h: -5,
      discharge: 1730,
      temperature: 26.6,
    };

    const veryClose = engine.score(current, {
      level: 15,
      delta24h: -6,
      discharge: 1760,
      temperature: 26.8,
    });

    const medium = engine.score(current, {
      level: 18,
      delta24h: -2,
      discharge: 1900,
      temperature: 24,
    });

    const far = engine.score(current, {
      level: 80,
      delta24h: 18,
      discharge: 5200,
      temperature: 15,
    });

    expect(veryClose).toBeLessThan(medium);
    expect(medium).toBeLessThan(far);

  });

  it('penalizes opposite river trend', () => {

    const current = {
      level: 14,
      delta24h: -5,
      discharge: 1730,
      temperature: 26.6,
    };

    const falling = engine.score(current, {
      level: 14,
      delta24h: -5,
      discharge: 1730,
      temperature: 26.6,
    });

    const rising = engine.score(current, {
      level: 14,
      delta24h: 8,
      discharge: 1730,
      temperature: 26.6,
    });

    expect(falling).toBeLessThan(rising);

  });

  it('penalizes discharge mismatch', () => {

    const current = {
      level: 14,
      delta24h: -5,
      discharge: 1730,
      temperature: 26.6,
    };

    const similar = engine.score(current, {
      level: 14,
      delta24h: -5,
      discharge: 1750,
      temperature: 26.6,
    });

    const different = engine.score(current, {
      level: 14,
      delta24h: -5,
      discharge: 3400,
      temperature: 26.6,
    });

    expect(similar).toBeLessThan(different);

  });

});
