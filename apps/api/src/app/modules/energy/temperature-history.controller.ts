import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MongoClient } from 'mongodb';
import { assertPortalControlToken } from '../portal/portal.controller';
import type { DeviceProxyRequest } from '../portal/portal-device-proxy.service';
import {
  LEGACY_POWER_CLIENT,
  LEGACY_POWER_CONFIG,
  LegacyPowerConfig,
} from './legacy-power.config';

const SENSORS = [
  { id: 'temp-kitchen', name: 'Kitchen' },
  { id: 'temp-garage', name: 'Garage' },
  { id: 'temp-bolier-room', name: 'Boiler room' },
] as const;

@Controller('portal/energy/temperatures')
export class TemperatureHistoryController {
  constructor(
    @Inject(LEGACY_POWER_CLIENT)
    private readonly client: MongoClient | null,
    @Inject(LEGACY_POWER_CONFIG)
    private readonly config: LegacyPowerConfig,
  ) {}

  @Get('history')
  async history(
    @Req() request: DeviceProxyRequest,
    @Query('hours') requestedHours?: string,
  ) {
    assertPortalControlToken(request);

    const hours = requestedHours === undefined ? 24 : Number(requestedHours);

    if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
      throw new BadRequestException(
        'hours must be an integer between 1 and 168',
      );
    }

    if (!this.client) {
      throw new ServiceUnavailableException(
        'Temperature history database is not configured.',
      );
    }

    const to = new Date();
    const from = new Date(to.getTime() - hours * 3600000);

    try {
      const collection = this.client
        .db(this.config.database)
        .collection('devicereadings');

      const sensors = await Promise.all(
        SENSORS.map(async (sensor) => {
          const rows = await collection.aggregate<{
            _id: Date;
            value: number;
            samples: number;
          }>(
            [
              {
                $match: {
                  deviceId: sensor.id,
                  type: 'temperature',
                  timestamp: { $gte: from, $lt: to },
                },
              },
              {
                $project: {
                  timestamp: 1,
                  temperature: {
                    $convert: {
                      input: '$value.value',
                      to: 'double',
                      onError: null,
                      onNull: null,
                    },
                  },
                },
              },
              {
                $match: {
                  temperature: { $gte: -50, $lte: 100 },
                },
              },
              {
                $group: {
                  _id: {
                    $dateTrunc: {
                      date: '$timestamp',
                      unit: 'hour',
                    },
                  },
                  value: { $avg: '$temperature' },
                  samples: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
              { $limit: 169 },
            ],
            { maxTimeMS: 10000 },
          ).toArray();

          return {
            id: sensor.id,
            name: sensor.name,
            points: rows.map((row) => ({
              timestamp: row._id.toISOString(),
              temperature: Math.round(row.value * 100) / 100,
              samples: row.samples,
            })),
          };
        }),
      );

      return {
        from: from.toISOString(),
        to: to.toISOString(),
        interval: 'hour',
        source: 'legacy-mongodb',
        sensors,
      };
    } catch {
      throw new ServiceUnavailableException(
        'Temperature history is temporarily unavailable.',
      );
    }
  }
}
