import {
  Inject,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  PowerHistory,
  PowerHistoryQuery,
  PowerHistoryReader,
} from '@energrid/domain-telemetry';
import { MongoClient } from 'mongodb';
import {
  LEGACY_POWER_CLIENT,
  LEGACY_POWER_CONFIG,
  LegacyPowerConfig,
} from './legacy-power.config';
import {
  LegacyPowerDocument,
  normalizeLegacyPower,
} from './legacy-power-normalizer';

@Injectable()
export class LegacyMongoPowerAdapter
  implements PowerHistoryReader, OnModuleDestroy
{
  constructor(
    @Inject(LEGACY_POWER_CONFIG) private readonly config: LegacyPowerConfig,
    @Inject(LEGACY_POWER_CLIENT) private readonly client: MongoClient | null,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.client?.close();
  }

  async read(assetId: string, query: PowerHistoryQuery): Promise<PowerHistory> {
    const binding = this.config.bindings.find((asset) => asset.id === assetId);
    if (!binding || !this.client)
      throw new ServiceUnavailableException(
        'Legacy power history is not configured.',
      );
    const from = new Date(query.from),
      to = new Date(query.to);
    const collection = this.client
      .db(this.config.database)
      .collection<LegacyPowerDocument>('devicereadings');
    const device = { deviceId: binding.sourceDeviceId, type: 'power' };
    const options = {
      projection: { _id: 0, timestamp: 1, value: 1, unit: 1 },
      maxTimeMS: 10000,
    };
    try {
      // The existing deviceId/type/timestamp index supports these bounded reads. No scans of other sensors.
      const before = await collection.findOne(
        {
          ...device,
          timestamp: { $lt: from, $gte: new Date(from.getTime() - 300000) },
        },
        { ...options, sort: { timestamp: -1 } },
      );
      const rows = await collection
        .find({ ...device, timestamp: { $gte: from, $lt: to } }, options)
        .sort({ timestamp: 1 })
        .limit(100001)
        .toArray();
      if (rows.length > 100000)
        throw new UnprocessableEntityException(
          'Too many readings for this range. Choose a shorter period.',
        );
      const after = await collection.findOne(
        {
          ...device,
          timestamp: { $gte: to, $lte: new Date(to.getTime() + 300000) },
        },
        { ...options, sort: { timestamp: 1 } },
      );
      let rejectedReadings = 0;
      const observations = [before, ...rows, after].flatMap((row) => {
        if (!row) return [];
        const observation = normalizeLegacyPower(row);
        if (!observation) {
          rejectedReadings++;
          return [];
        }
        return [observation];
      });
      return {
        observations,
        rejectedReadings,
        source: 'legacy-mongo-power',
        timestampBasis: 'collector-received',
      };
    } catch (error) {
      if (error instanceof UnprocessableEntityException) throw error;
      // Connection errors can contain credentials and hosts. Never expose the driver error to clients.
      throw new ServiceUnavailableException(
        'Legacy power history is unavailable. Check the database connection.',
      );
    }
  }
}
