import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  analyzePowerHistory,
  type PowerAsset,
  type PowerHistoryQuery,
  type PowerHistoryReader,
} from '@energrid/domain-telemetry';
import {
  POWER_ASSET_CATALOG,
  POWER_HISTORY_READER,
  PowerAssetCatalog,
  publicPowerAsset,
} from './power-asset-catalog';

export function parsePowerRange(
  from: unknown,
  to: unknown,
  now = Date.now(),
): PowerHistoryQuery {
  const isoInstant = (value: unknown): value is string =>
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
  if (!isoInstant(from) || !isoInstant(to))
    throw new BadRequestException('Use UTC ISO timestamps for from and to.');
  const start = Date.parse(from),
    end = Date.parse(to);
  if (end <= start || end - start > 31 * 86400000 || end > now + 1000)
    throw new BadRequestException(
      'Choose a past period between zero and 31 days.',
    );
  return {
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
  };
}

@Injectable()
export class EnergyService {
  constructor(
    @Inject(POWER_ASSET_CATALOG) private readonly config: PowerAssetCatalog,
    @Inject(POWER_HISTORY_READER) private readonly history: PowerHistoryReader,
  ) {}

  assets(): { configured: boolean; assets: PowerAsset[] } {
    const tenant = process.env.PORTAL_TENANT_ID || 'tenant-demo';
    const site =
      process.env.PORTAL_SITE_ID || process.env.HOME_SITE_ID || 'site-home';
    return {
      configured: this.config.configured,
      assets: this.config.bindings
        .filter(
          (binding) => binding.tenantId === tenant && binding.siteId === site,
        )
        .map(publicPowerAsset),
    };
  }

  async dashboard(assetId: string, from: unknown, to: unknown) {
    const asset = this.assets().assets.find((item) => item.id === assetId);
    if (!asset)
      throw new NotFoundException('Power asset is not assigned to this site.');
    const range = parsePowerRange(from, to);
    const history = await this.history.read(asset.id, range);
    const analysis = analyzePowerHistory(history.observations, range, asset);
    return {
      asset,
      range,
      source: history.source,
      timestampBasis: history.timestampBasis,
      rejectedReadings: history.rejectedReadings,
      ...analysis,
    };
  }
}
