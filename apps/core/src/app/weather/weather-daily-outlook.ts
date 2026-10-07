import { WeatherDay, WeatherSnapshot } from './weather-data-quality';

type DailyAgreement = 'agreement' | 'disagreement' | 'single-model';

export interface DailyOutlookDay extends WeatherDay {
  sourceProvider: string;
  sourceModel: string | null;
  isFallback: boolean;
  agreement: DailyAgreement;
  selectionReason: string;
  disagreementReasons: string[];
  comparedModels: string[];
}

export interface DailyOutlook {
  policy: 'daily-agreement-then-cautious-selection';
  selectedModel: string | null;
  days: DailyOutlookDay[];
  sourceModels: string[];
  agreementDays: number;
  disagreementDays: number;
  singleModelDays: number;
}

export function buildDailyOutlook(selected: WeatherSnapshot, snapshots: WeatherSnapshot[], limit = 10): DailyOutlook {
  const selectedKey = snapshotKey(selected);
  const candidatesByDate = new Map<string, DailyCandidate[]>();

  for (const snapshot of orderedSnapshots(selected, snapshots)) {
    if (snapshot.availability !== 'available') continue;
    const key = snapshotKey(snapshot);

    for (const day of snapshot.daily ?? []) {
      if (!isPopulatedDailyForecast(day)) continue;
      const candidates = candidatesByDate.get(day.date) ?? [];
      candidates.push({ day, snapshot, key });
      candidatesByDate.set(day.date, candidates);
    }
  }

  const days = [...candidatesByDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, candidates]) => selectDailyForecast(candidates, selectedKey))
    .slice(0, limit);

  return {
    policy: 'daily-agreement-then-cautious-selection',
    selectedModel: selected.model ?? null,
    days,
    sourceModels: [...new Set(days.map((day) => modelLabel(day.sourceProvider, day.sourceModel)))],
    agreementDays: days.filter((day) => day.agreement === 'agreement').length,
    disagreementDays: days.filter((day) => day.agreement === 'disagreement').length,
    singleModelDays: days.filter((day) => day.agreement === 'single-model').length,
  };
}

export function isPopulatedDailyForecast(day: WeatherDay): boolean {
  return Boolean(day.date) && [
    day.tempMax,
    day.tempMin,
    day.rainTotalMm,
    day.rainChanceMax,
    day.weatherCode,
    day.windMaxKmh,
    day.gustMaxKmh,
  ].some((value) => typeof value === 'number' && Number.isFinite(value));
}

function orderedSnapshots(selected: WeatherSnapshot, snapshots: WeatherSnapshot[]) {
  const byKey = new Map<string, WeatherSnapshot>();
  byKey.set(snapshotKey(selected), selected);
  for (const snapshot of snapshots) byKey.set(snapshotKey(snapshot), snapshot);
  return [...byKey.values()];
}

interface DailyCandidate {
  day: WeatherDay;
  snapshot: WeatherSnapshot;
  key: string;
}

function selectDailyForecast(candidates: DailyCandidate[], selectedKey: string): DailyOutlookDay {
  const disagreementReasons = dailyDisagreementReasons(candidates.map((candidate) => candidate.day));
  const selectedCandidate = candidates.find((candidate) => candidate.key === selectedKey);
  const agreement = candidates.length < 2 ? 'single-model' : disagreementReasons.length ? 'disagreement' : 'agreement';
  const chosen = agreement === 'disagreement'
    ? mostCautious(candidates)
    : selectedCandidate ?? candidates[0];

  return {
    ...chosen.day,
    sourceProvider: chosen.snapshot.provider,
    sourceModel: chosen.snapshot.model ?? null,
    isFallback: chosen.key !== selectedKey,
    agreement,
    selectionReason: selectionReason(agreement, chosen.key !== selectedKey),
    disagreementReasons,
    comparedModels: candidates.map((candidate) => modelLabel(candidate.snapshot.provider, candidate.snapshot.model ?? null)),
  };
}

function selectionReason(agreement: DailyAgreement, isFallback: boolean) {
  if (agreement === 'single-model') return isFallback
    ? 'Only one model has a populated daily forecast for this date; showing that model.'
    : 'Only the selected model has a populated daily forecast for this date.';
  if (agreement === 'agreement') return 'Models agree within daily thresholds; showing the selected safety model forecast.';
  return 'Models disagree for this date; showing the more cautious daily forecast.';
}

function mostCautious(candidates: DailyCandidate[]) {
  return [...candidates].sort((left, right) =>
    dailyCautionScore(right.day) - dailyCautionScore(left.day))[0];
}

function dailyDisagreementReasons(days: WeatherDay[]) {
  if (days.length < 2) return [];

  const reasons: string[] = [];
  const categories = [...new Set(days.map(dailyRiskCategory))];
  if (categories.length > 1) reasons.push('daily-risk-category-differs');
  if ((spread(days.map((day) => day.rainTotalMm)) ?? 0) >= 2) reasons.push('rain-total-spread-at-least-2-mm');
  if ((spread(days.map((day) => day.rainChanceMax)) ?? 0) >= 30) reasons.push('rain-probability-spread-at-least-30-points');
  if ((spread(days.map((day) => day.gustMaxKmh)) ?? 0) >= 15) reasons.push('gust-spread-at-least-15-kmh');
  if ((spread(days.map((day) => day.tempMax)) ?? 0) >= 4) reasons.push('temperature-spread-at-least-4-c');
  return reasons;
}

function dailyCautionScore(day: WeatherDay) {
  return dailyRiskRank(day) * 1_000_000 +
    value(day.gustMaxKmh) * 1_000 +
    value(day.rainTotalMm) * 100 +
    value(day.rainChanceMax);
}

function dailyRiskCategory(day: WeatherDay) {
  const rank = dailyRiskRank(day);
  if (rank >= 3) return 'danger';
  if (rank === 2) return 'watch';
  if (rank === 1) return 'wet-or-breezy';
  return 'normal';
}

function dailyRiskRank(day: WeatherDay) {
  const code = day.weatherCode ?? -1;
  const gust = value(day.gustMaxKmh);
  const rain = value(day.rainTotalMm);
  const chance = value(day.rainChanceMax);
  if ([96, 99].includes(code) || gust >= 70 || code === 82 || rain >= 30) return 3;
  if ([95, 65, 81].includes(code) || gust >= 55 || rain >= 15 || chance >= 70) return 2;
  if ([51, 53, 55, 61, 63, 80].includes(code) || gust >= 35 || rain >= 2 || chance >= 35) return 1;
  return 0;
}

function spread(values: Array<number | null | undefined>) {
  const clean = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return clean.length > 1 ? Math.max(...clean) - Math.min(...clean) : null;
}

function value(input: number | null | undefined) {
  return typeof input === 'number' && Number.isFinite(input) ? input : 0;
}

function snapshotKey(snapshot: WeatherSnapshot) {
  return `${snapshot.provider}:${snapshot.model ?? 'unspecified'}`;
}

function modelLabel(provider: string, model: string | null) {
  return `${provider}:${model ?? 'unspecified'}`;
}
