import { assessWeather, forecastWindow, WeatherSnapshot } from './weather-data-quality';
import { WeatherRiskEngine } from './weather-risk.engine';
import { WeatherIntelligenceService } from './weather-intelligence.service';
import { decideWeatherModel } from './weather-model-decision';

export function compareWeather(snapshots: WeatherSnapshot[], river: unknown,
  riskEngine: WeatherRiskEngine, intelligenceService: WeatherIntelligenceService) {
  if (!snapshots.length) throw new Error('At least one weather source is required');
  const unique = [...new Map(snapshots.map(snapshot => [snapshot.provider + ':' + (snapshot.model ?? 'unspecified'), snapshot])).values()];
  const outcomes = unique.map(snapshot => ({ snapshot, quality: assessWeather(snapshot),
    risk: riskEngine.evaluate(snapshot),
    intelligence: intelligenceService.analyze(snapshot, river, undefined),
  }));
  const decision = decideWeatherModel(outcomes.map(source => {
    const horizon = forecastWindow(source.snapshot).slice(0, 7);
    return {
      key: source.snapshot.provider + ':' + (source.snapshot.model ?? 'unspecified'),
      provider: source.snapshot.provider,
      model: source.snapshot.model ?? null,
      usable: source.quality.forecastUsable,
      severity: source.intelligence.severity,
      maxGustKmh: max(horizon.map(hour => hour.gustKmh)),
      maxRainChance: max(horizon.map(hour => hour.rainChance)),
      rainTotalMm: sum(horizon.map(hour => hour.precipitationMm)),
    };
  }));
  const selected = outcomes.find(source =>
    source.snapshot.provider + ':' + (source.snapshot.model ?? 'unspecified') === decision.selectedKey) ?? outcomes[0];
  return { selected, comparison: {
    status: decision.status,
    selectedModel: decision.selectedModel,
    selectionPolicy: decision.selectionPolicy,
    selectionReason: decision.selectionReason,
    usableModels: decision.usableModels,
    transportProviders: [...new Set(snapshots.map(s => s.provider))],
    gustSpreadKmh: decision.gustSpreadKmh,
    rainChanceSpreadPoints: decision.rainChanceSpreadPoints,
    disagreementReasons: decision.disagreementReasons,
    automationEligible: false,
    sources: outcomes.map(source => ({ provider: source.snapshot.provider, model: source.snapshot.model,
      fetchedAt: source.snapshot.fetchedAt, dataQuality: source.quality,
      severity: source.intelligence.severity })),
  } };
}

function max(values: Array<number | null | undefined>) {
  const clean = values.filter((value): value is number => typeof value === 'number');
  return clean.length ? Math.max(...clean) : 0;
}

function sum(values: Array<number | null | undefined>) {
  return values.reduce<number>((total, value) => total + (typeof value === 'number' ? value : 0), 0);
}
