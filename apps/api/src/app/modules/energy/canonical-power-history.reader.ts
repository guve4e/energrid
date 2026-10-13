import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  utcInstant,
  type PowerHistory,
  type PowerHistoryQuery,
  type PowerHistoryReader,
} from '@energrid/domain-telemetry';
import {
  TelemetryStore,
  type MeasurementStream,
} from '../telemetry/telemetry.store';
import {
  CANONICAL_POWER_CONFIG,
  CanonicalPowerBinding,
  CanonicalPowerConfig,
  MeterAssignment,
} from './canonical-power.config';

@Injectable()
export class CanonicalPowerHistoryReader implements PowerHistoryReader {
  constructor(
    @Inject(CANONICAL_POWER_CONFIG)
    private readonly config: CanonicalPowerConfig,
    private readonly store: TelemetryStore,
  ) {}

  private binding(id: string): CanonicalPowerBinding {
    const asset = this.config.bindings.find(
      (a) =>
        a.id === id &&
        a.tenantId === (process.env.PORTAL_TENANT_ID || 'tenant-demo') &&
        a.siteId ===
          (process.env.PORTAL_SITE_ID ||
            process.env.HOME_SITE_ID ||
            'site-home'),
    );
    if (!asset)
      throw new NotFoundException('Power asset is not assigned to this site.');
    return asset;
  }

  private stream(
    asset: CanonicalPowerBinding,
    meter: MeterAssignment,
  ): MeasurementStream {
    return {
      tenantId: asset.tenantId,
      siteId: asset.siteId,
      deviceId: meter.deviceId,
      channel: meter.channel,
      metric: 'power',
    };
  }

  async read(id: string, query: PowerHistoryQuery): Promise<PowerHistory> {
    const asset = this.binding(id);
    try {
      const observations: PowerHistory['observations'] = [];
      const bases = new Set<string>();
      for (const meter of asset.meters) {
        const from = query.from > meter.from ? query.from : meter.from;
        const to = meter.to && meter.to < query.to ? meter.to : query.to;
        if (from >= to) continue;
        const rows = await this.store.read(this.stream(asset, meter), from, to);
        for (const r of rows) {
          if (
            r.observedAt < meter.from ||
            (meter.to && r.observedAt >= meter.to)
          )
            continue;
          bases.add(r.timestampBasis);
          observations.push({
            observedAt: r.observedAt,
            powerW: r.value === null ? null : Math.max(0, r.value),
            seriesId: `${meter.deviceId}/${meter.channel}/${meter.from}`,
          });
        }
        if (observations.length > 100000)
          throw new Error('Too many assigned readings');
      }
      return {
        observations,
        rejectedReadings: 0,
        source: 'energrid-postgres-power',
        timestampBasis:
          bases.size > 1
            ? 'mixed'
            : bases.has('device-observed')
              ? 'device-observed'
              : 'collector-received',
      };
    } catch {
      throw new ServiceUnavailableException(
        'Energrid reading history is unavailable. Check telemetry storage or choose a shorter period.',
      );
    }
  }

  async summaries(id: string, inputFrom: unknown, inputTo: unknown) {
    const asset = this.binding(id);
    let from: string, to: string;
    try {
      from = utcInstant(inputFrom);
      to = utcInstant(inputTo);
      if (
        Date.parse(from) % 3_600_000 ||
        Date.parse(to) % 3_600_000 ||
        from >= to ||
        Date.parse(to) - Date.parse(from) > 366 * 86400000 ||
        Date.parse(to) > Date.now()
      )
        throw new Error();
    } catch {
      throw new Error(
        'Choose past UTC hour boundaries, at most 366 days apart.',
      );
    }
    try {
      const series = [];
      for (const meter of asset.meters) {
        const buckets = await this.store.hourly(
          this.stream(asset, meter),
          from,
          to,
        );
        // A UTC rollup is usable only if its whole hour belongs to this appliance.
        series.push({
          deviceId: meter.deviceId,
          channel: meter.channel,
          buckets: buckets.filter(
            (b) =>
              b.hour >= meter.from &&
              (!meter.to ||
                Date.parse(b.hour) + 3_600_000 <= Date.parse(meter.to)),
          ),
        });
      }
      return {
        resolution: 'UTC-hour',
        aggregationVersion: 1,
        range: { from, to },
        series,
        freshness: 'asynchronous',
        note: 'Missing buckets are unknown, not zero. Partial assignment hours require raw history.',
      };
    } catch {
      throw new ServiceUnavailableException(
        'Energrid hourly summaries are unavailable.',
      );
    }
  }
}
