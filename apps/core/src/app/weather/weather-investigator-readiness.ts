import type { WeatherReadModel } from './weather-read-model';

/** The scheduler is process-local; persisted evidence is queried independently. */
export interface WeatherInvestigatorScheduleState {
  enabled: boolean;
  running: boolean;
  intervalMinutes: number;
  consecutiveFailures: number;
  lastAttemptAt: string | null;
  lastCompletedAt: string | null;
  lastOutcome: 'completed' | 'already-running' | 'weather-unavailable' | 'stale-or-incomplete' | 'error' | null;
  nextAttemptAt: string | null;
}

export type WeatherReadinessStatus =
  | 'ready'
  | 'collecting'
  | 'waiting_for_first_snapshot'
  | 'disabled'
  | 'misconfigured'
  | 'storage_unavailable'
  | 'provider_unavailable'
  | 'collection_failed'
  | 'incomplete_forecast'
  | 'stale_forecast';

export type WeatherConfigurationIssue = 'lab_disabled' | 'scheduler_disabled' | 'site_configuration_missing' | null;

export interface WeatherInvestigatorReadiness {
  version: 1;
  scope: { siteId: string; tenantId: string };
  generatedAt: string;
  status: WeatherReadinessStatus;
  reason: string | null;
  schedule: WeatherInvestigatorScheduleState;
  evidence: null | {
    status: WeatherReadModel['status'];
    capturedAt: string;
    ageMinutes: number | null;
    provider: string;
    model: string | null;
    coverage: NonNullable<WeatherReadModel['forecast']>['coverage'];
  };
}

/** A bounded, read-only projection. No live provider calls or hidden refreshes. */
export function buildWeatherInvestigatorReadiness(
  scope: { siteId: string; tenantId: string },
  schedule: WeatherInvestigatorScheduleState,
  configurationIssue: WeatherConfigurationIssue,
  readModel: WeatherReadModel | null,
  storageFailed: boolean,
  now = Date.now(),
): WeatherInvestigatorReadiness {
  const evidence = readModel?.forecast
    ? {
        status: readModel.status,
        capturedAt: readModel.forecast.capturedAt,
        ageMinutes: readModel.forecast.ageMinutes,
        provider: readModel.forecast.provider,
        model: readModel.forecast.model,
        coverage: readModel.forecast.coverage,
      }
    : null;

  let status: WeatherReadinessStatus;
  let reason: string | null = null;
  if (configurationIssue === 'lab_disabled' || configurationIssue === 'scheduler_disabled') {
    status = 'disabled';
    reason = configurationIssue;
  } else if (configurationIssue) {
    status = 'misconfigured';
    reason = configurationIssue;
  } else if (storageFailed) {
    status = 'storage_unavailable';
    reason = 'storage_query_failed';
  } else if (schedule.lastOutcome === 'weather-unavailable') {
    status = 'provider_unavailable';
    reason = 'upstream_unavailable';
  } else if (schedule.lastOutcome === 'error') {
    status = 'collection_failed';
    reason = 'collection_error';
  } else if (readModel?.status === 'unavailable' &&
             readModel.quality.reasons.includes('invalid_source')) {
    status = 'incomplete_forecast';
    reason = 'invalid_source';
  } else if (readModel?.status === 'stale') {
    status = 'stale_forecast';
    reason = readModel.quality.reasons[0] ?? 'stale';
  } else if (readModel?.status === 'partial') {
    status = 'incomplete_forecast';
    reason = readModel.quality.reasons[0] ?? 'incomplete_24h';
  } else if (readModel?.status === 'available') {
    status = 'ready';
  } else if (schedule.running) {
    status = 'collecting';
  } else if (schedule.lastOutcome === 'stale-or-incomplete') {
    status = 'incomplete_forecast';
    reason = 'provider_data_rejected';
  } else {
    status = 'waiting_for_first_snapshot';
    reason = 'no_snapshot';
  }

  return {
    version: 1,
    scope,
    generatedAt: new Date(now).toISOString(),
    status,
    reason,
    schedule,
    evidence,
  };
}
