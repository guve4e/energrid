export type ModelDecisionStatus = 'agreement' | 'disagreement' | 'insufficient-data';
export type ForecastSeverity = 'unknown' | 'normal' | 'watch' | 'danger' | string;

export interface WeatherModelCandidate {
  key: string;
  provider: string;
  model: string | null;
  usable: boolean;
  severity: ForecastSeverity;
  maxGustKmh: number;
  maxRainChance: number;
  rainTotalMm: number;
  learnedReliability?: number | null;
}

export interface WeatherModelDecision {
  status: ModelDecisionStatus;
  selectedKey: string;
  selectedModel: string | null;
  selectionPolicy: 'safety-first-then-learned-reliability';
  selectionReason: string;
  usableModels: number;
  gustSpreadKmh: number | null;
  rainChanceSpreadPoints: number | null;
  disagreementReasons: string[];
  sources: Array<WeatherModelCandidate & { selectionScore: number }>;
}

const severityRank = (severity: ForecastSeverity) =>
  severity === 'danger' ? 3 : severity === 'watch' ? 2 : severity === 'normal' ? 1 : 0;

export function decideWeatherModel(candidates: WeatherModelCandidate[]): WeatherModelDecision {
  if (!candidates.length) throw new Error('At least one weather model candidate is required');

  const usable = candidates.filter((candidate) => candidate.usable);
  const scored = candidates.map((candidate) => ({ ...candidate, selectionScore: selectionScore(candidate) }));
  const selected = [...usable].sort((a, b) => selectionScore(b) - selectionScore(a))[0] ?? candidates[0];
  const gustSpreadKmh = spread(usable.map((candidate) => candidate.maxGustKmh));
  const rainChanceSpreadPoints = spread(usable.map((candidate) => candidate.maxRainChance));
  const disagreementReasons = [
    ...severityDisagreements(usable),
    ...thresholdDisagreements(gustSpreadKmh, rainChanceSpreadPoints),
  ];
  const status: ModelDecisionStatus = usable.length < 2 ? 'insufficient-data' :
    disagreementReasons.length ? 'disagreement' : 'agreement';

  return {
    status,
    selectedKey: selected.key,
    selectedModel: selected.model,
    selectionPolicy: 'safety-first-then-learned-reliability',
    selectionReason: selectionReason(selected, usable),
    usableModels: usable.length,
    gustSpreadKmh,
    rainChanceSpreadPoints,
    disagreementReasons,
    sources: scored,
  };
}

function selectionScore(candidate: WeatherModelCandidate) {
  if (!candidate.usable) return -1;
  return severityRank(candidate.severity) * 100000 +
    candidate.maxGustKmh * 100 +
    candidate.maxRainChance +
    candidate.rainTotalMm +
    (candidate.learnedReliability ?? 0);
}

function selectionReason(selected: WeatherModelCandidate, usable: WeatherModelCandidate[]) {
  if (!selected.usable) return 'No usable forecast model is available; showing the first unavailable source for diagnosis.';
  if (usable.length < 2) return 'Only one usable forecast model is available.';
  const selectedRank = severityRank(selected.severity);
  const lessCautious = usable.some((candidate) => severityRank(candidate.severity) < selectedRank);
  if (lessCautious) return 'Selected because it reports the highest weather risk among usable models.';
  const maxReliability = Math.max(...usable.map((candidate) => candidate.learnedReliability ?? 0));
  if ((selected.learnedReliability ?? 0) > 0 && (selected.learnedReliability ?? 0) === maxReliability) {
    return 'Selected by learned reliability after safety risk matched across usable models.';
  }
  return 'Selected by conservative tie-breakers after usable models reported matching risk.';
}

function severityDisagreements(candidates: WeatherModelCandidate[]) {
  const severities = [...new Set(candidates.map((candidate) => candidate.severity))];
  return severities.length > 1 ? ['models-report-different-risk-levels'] : [];
}

function thresholdDisagreements(gustSpreadKmh: number | null, rainChanceSpreadPoints: number | null) {
  const reasons: string[] = [];
  if ((gustSpreadKmh ?? 0) >= 20) reasons.push('wind-gust-spread-at-least-20-kmh');
  if ((rainChanceSpreadPoints ?? 0) >= 40) reasons.push('rain-probability-spread-at-least-40-points');
  return reasons;
}

function spread(values: number[]) {
  if (values.length < 2) return null;
  return Math.max(...values) - Math.min(...values);
}
