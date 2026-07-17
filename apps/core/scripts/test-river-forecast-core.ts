import assert from 'node:assert/strict';

import { HistoricalAnalogueEngine } from '../src/app/weather/river/analogue/historical-analogue.engine';
import { ForecastBacktestEngine } from '../src/app/weather/river/backtest/forecast-backtest.engine';
import { ConfidenceEngine } from '../src/app/weather/river/engines/confidence/confidence.engine';
import { ForecastEngine } from '../src/app/weather/river/engines/forecast.engine';
import { TravelTimeEngine } from '../src/app/weather/river/engines/travel-time.engine';
import { DailyPropagationEngine } from '../src/app/weather/river/engines/propagation/daily-propagation.engine';
import { NOVO_SELO_TO_LOM_DAILY_MODEL } from '../src/app/weather/river/engines/propagation/validated-propagation.models';

function testHistoricalAnalogues() {
  const engine = new HistoricalAnalogueEngine();

  const current = {
    level: 14,
    delta24h: -5,
    discharge: 1730,
    temperature: 26.6,
    month: 7,
  };

  const identical = engine.score(current, current);

  const close = engine.score(current, {
    level: 15,
    delta24h: -6,
    discharge: 1760,
    temperature: 26.8,
    month: 7,
  });

  const oppositeTrend = engine.score(current, {
    level: 14,
    delta24h: 8,
    discharge: 1730,
    temperature: 26.6,
    month: 7,
  });

  const wrongSeason = engine.score(current, {
    level: 14,
    delta24h: -5,
    discharge: 1730,
    temperature: 26.6,
    month: 1,
  });

  assert.equal(identical, 0);
  assert.ok(close > identical);
  assert.ok(close < oppositeTrend);
  assert.ok(wrongSeason >= 20);

  console.log('✓ Historical analogue scoring');
}

function testTravelTime() {
  const engine = new TravelTimeEngine();

  const propagation = engine.find(
    'novo-selo',
    'vidin',
  );

  assert.ok(propagation);
  assert.equal(propagation.averageHours, 8);
  assert.equal(propagation.confidence, 'medium');

  assert.equal(
    engine.find('unknown', 'vidin'),
    null,
  );

  console.log('✓ Travel-time route lookup');
}

function testForecastEngine() {
  const engine = new ForecastEngine();

  const falling = engine.predict({
    currentCm: 14,
    hours: 24,
    totalChange: -5,
    points: 24,
    change24hCm: -5,
    upstreamTrend: 'falling',
    upstreamDischarge: 1730,
    downstreamTrend: 'falling',
  });

  assert.equal(falling.trend, 'falling');
  assert.equal(falling.confidence, 'high');
  assert.equal(
    falling.projection.next24h.direction,
    'falling',
  );

  const rising = engine.predict({
    currentCm: 14,
    hours: 24,
    totalChange: 1,
    points: 24,
    change24hCm: 1,
    upstreamTrend: 'rising',
  });

  assert.equal(rising.trend, 'rising');

  console.log('✓ Forecast direction and confidence');
}

function testConfidenceEngine() {
  const engine = new ConfidenceEngine();

  const strong = engine.evaluate({
    historyPoints: 48,
    analogueScore: 2,
    upstreamAgreement: true,
    rainfallAvailable: true,
  });

  assert.equal(strong.score, 100);
  assert.equal(strong.confidence, 'high');
  assert.equal(strong.reasons.length, 4);

  const weak = engine.evaluate({
    historyPoints: 2,
    analogueScore: 30,
    upstreamAgreement: false,
    rainfallAvailable: false,
  });

  assert.equal(weak.score, 0);
  assert.equal(weak.confidence, 'low');

  console.log('✓ Explainable confidence scoring');
}

function testDailyPropagationEngine() {
  const engine =
    new DailyPropagationEngine();

  const falling = engine.predict(
    NOVO_SELO_TO_LOM_DAILY_MODEL,
    {
      upstreamDelta24hCm: -8,
      downstreamDelta24hCm: -5,
      downstreamCurrentLevelCm: 29,
    },
  );

  assert.equal(
    falling.predictedDelta24hCm,
    -4.5,
  );

  assert.equal(
    falling.expectedLevelCm,
    24.5,
  );

  assert.equal(
    falling.direction,
    'falling',
  );

  const rising = engine.predict(
    NOVO_SELO_TO_LOM_DAILY_MODEL,
    {
      upstreamDelta24hCm: 20,
      downstreamDelta24hCm: 3,
      downstreamCurrentLevelCm: 100,
    },
  );

  assert.equal(
    rising.direction,
    'rising',
  );

  assert.ok(
    rising.predictedDelta24hCm > 10,
  );

  console.log(
    '✓ Validated daily propagation model',
  );
}

function testBacktester() {
  const engine = new ForecastBacktestEngine();

  const result = engine.evaluate([
    { predicted: 10, actual: 12 },
    { predicted: 14, actual: 13 },
    { predicted: 8, actual: 10 },
  ]);

  assert.ok(result);
  assert.equal(result.samples, 3);
  assert.equal(result.mae, 1.67);
  assert.equal(result.rmse, 1.73);

  assert.equal(engine.evaluate([]), null);

  console.log('✓ Backtest metrics');
}

function main() {
  testHistoricalAnalogues();
  testTravelTime();
  testForecastEngine();
  testConfidenceEngine();
  testDailyPropagationEngine();
  testBacktester();

  console.log('\n✓ All river forecast core tests passed');
}

main();
