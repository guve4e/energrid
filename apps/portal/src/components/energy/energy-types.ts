import type {
  PowerAnalysis,
  PowerAsset,
  PowerHistoryQuery,
} from '@energrid/domain-telemetry';

export type EnergyDashboard = PowerAnalysis & {
  asset: PowerAsset;
  range: PowerHistoryQuery;
  source: string;
  timestampBasis: 'collector-received' | 'device-observed' | 'mixed';
  rejectedReadings: number;
};

export function recentPowerRange(
  days: number,
  now = new Date(),
): PowerHistoryQuery {
  return {
    from: new Date(now.getTime() - days * 86400000).toISOString(),
    to: now.toISOString(),
  };
}
