import { assessWeather, forecastWindow, WeatherSnapshot } from './weather-data-quality';
import { WeatherRiskEngine } from './weather-risk.engine';
import { WeatherIntelligenceService } from './weather-intelligence.service';

export function compareWeather(snapshots: WeatherSnapshot[], river: unknown,
  riskEngine: WeatherRiskEngine, intelligenceService: WeatherIntelligenceService) {
  if (!snapshots.length) throw new Error('At least one weather source is required');
  const unique = [...new Map(snapshots.map(snapshot => [snapshot.provider + ':' + (snapshot.model ?? 'unspecified'), snapshot])).values()];
  const outcomes = unique.map(snapshot => ({ snapshot, quality: assessWeather(snapshot),
    risk: riskEngine.evaluate(snapshot),
    intelligence: intelligenceService.analyze(snapshot, river, undefined),
  }));
  const usable = outcomes.filter(source => source.quality.forecastUsable);
  const rank = (severity: string) => severity === 'danger' ? 2 : severity === 'watch' ? 1 : 0;
  // Preserve the most cautious usable model's view, rather than blending incompatible forecasts.
  const selected = [...usable].sort((a, b) => rank(b.intelligence.severity) - rank(a.intelligence.severity))[0] ?? outcomes[0];
  const horizons = usable.map(source => forecastWindow(source.snapshot).slice(0, 7));
  const maxSpread = (field: 'gustKmh' | 'rainChance') => horizons.length < 2 ? null :
    Math.max(...Array.from({ length: 7 }, (_, index) => {
      const values = horizons.map(hours => hours[index][field]!);
      return Math.max(...values) - Math.min(...values);
    }));
  const gustSpreadKmh = maxSpread('gustKmh');
  const rainChanceSpreadPoints = maxSpread('rainChance');
  const disagrees = new Set(usable.map(source => source.intelligence.severity)).size > 1 ||
    (gustSpreadKmh ?? 0) >= 20 || (rainChanceSpreadPoints ?? 0) >= 40;
  return { selected, comparison: {
    status: usable.length < 2 ? 'insufficient-data' : disagrees ? 'disagreement' : 'agreement',
    selectedModel: selected.snapshot.model ?? null,
    selectionPolicy: 'most-cautious-usable-model',
    usableModels: usable.length,
    transportProviders: [...new Set(snapshots.map(s => s.provider))],
    gustSpreadKmh, rainChanceSpreadPoints,
    automationEligible: false,
    sources: outcomes.map(source => ({ provider: source.snapshot.provider, model: source.snapshot.model,
      fetchedAt: source.snapshot.fetchedAt, dataQuality: source.quality,
      severity: source.intelligence.severity })),
  } };
}
