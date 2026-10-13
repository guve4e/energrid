import type { PowerAsset } from '@energrid/domain-telemetry';

export const POWER_ASSET_CATALOG = Symbol('POWER_ASSET_CATALOG');
export const POWER_HISTORY_READER = Symbol('POWER_HISTORY_READER');
export interface PowerAssetCatalog {
  configured: boolean;
  bindings: PowerAsset[];
}

export function publicPowerAsset(asset: PowerAsset): PowerAsset {
  return {
    id: asset.id,
    displayName: asset.displayName,
    tenantId: asset.tenantId,
    siteId: asset.siteId,
    timezone: asset.timezone,
    activeThresholdW: asset.activeThresholdW,
    ...(asset.capacityLiters === undefined
      ? {}
      : { capacityLiters: asset.capacityLiters }),
    ...(asset.schedule ? { schedule: asset.schedule } : {}),
    ...(asset.measurementSources
      ? { measurementSources: asset.measurementSources }
      : {}),
  };
}
