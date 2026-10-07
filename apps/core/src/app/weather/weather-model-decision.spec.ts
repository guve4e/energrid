import { decideWeatherModel, WeatherModelCandidate } from './weather-model-decision';

const candidate = (overrides: Partial<WeatherModelCandidate>): WeatherModelCandidate => ({
  key: 'open-meteo:icon',
  provider: 'open-meteo',
  model: 'icon',
  usable: true,
  severity: 'normal',
  maxGustKmh: 10,
  maxRainChance: 0,
  rainTotalMm: 0,
  learnedReliability: null,
  ...overrides,
});

describe('weather model decision engine', () => {
  it('selects the highest-risk usable forecast before optimism', () => {
    const decision = decideWeatherModel([
      candidate({ key: 'open-meteo:icon', model: 'icon', severity: 'normal' }),
      candidate({ key: 'open-meteo:gfs', model: 'gfs', severity: 'danger' }),
    ]);

    expect(decision.selectedModel).toBe('gfs');
    expect(decision.status).toBe('disagreement');
    expect(decision.selectionReason).toBe('Selected because it reports the highest weather risk among usable models.');
    expect(decision.disagreementReasons).toContain('models-report-different-risk-levels');
  });

  it('does not let an unusable dangerous forecast drive the selected model', () => {
    const decision = decideWeatherModel([
      candidate({ key: 'open-meteo:icon', model: 'icon', severity: 'normal' }),
      candidate({ key: 'open-meteo:gfs', model: 'gfs', usable: false, severity: 'danger', maxGustKmh: 100 }),
    ]);

    expect(decision.selectedModel).toBe('icon');
    expect(decision.usableModels).toBe(1);
    expect(decision.status).toBe('insufficient-data');
  });

  it('marks disagreement when wind or rain spreads are operationally large', () => {
    const decision = decideWeatherModel([
      candidate({ key: 'open-meteo:icon', model: 'icon', maxGustKmh: 10, maxRainChance: 5 }),
      candidate({ key: 'open-meteo:gfs', model: 'gfs', maxGustKmh: 31, maxRainChance: 45 }),
    ]);

    expect(decision.status).toBe('disagreement');
    expect(decision.gustSpreadKmh).toBe(21);
    expect(decision.rainChanceSpreadPoints).toBe(40);
    expect(decision.disagreementReasons).toEqual([
      'wind-gust-spread-at-least-20-kmh',
      'rain-probability-spread-at-least-40-points',
    ]);
  });

  it('uses learned reliability only after safety risk matches', () => {
    const decision = decideWeatherModel([
      candidate({ key: 'open-meteo:icon', model: 'icon', learnedReliability: 0.2 }),
      candidate({ key: 'open-meteo:gfs', model: 'gfs', learnedReliability: 0.8 }),
    ]);

    expect(decision.selectedModel).toBe('gfs');
    expect(decision.status).toBe('agreement');
    expect(decision.selectionReason).toBe('Selected by learned reliability after safety risk matched across usable models.');
  });

  it('falls back to the first source for diagnosis when no model is usable', () => {
    const decision = decideWeatherModel([
      candidate({ key: 'open-meteo:icon', model: 'icon', usable: false }),
      candidate({ key: 'open-meteo:gfs', model: 'gfs', usable: false }),
    ]);

    expect(decision.selectedModel).toBe('icon');
    expect(decision.usableModels).toBe(0);
    expect(decision.selectionReason).toBe('No usable forecast model is available; showing the first unavailable source for diagnosis.');
  });
});
