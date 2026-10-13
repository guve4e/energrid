import { Module } from '@nestjs/common';
import { MongoClient } from 'mongodb';
import { EnergyController } from './energy.controller';
import { EnergyService } from './energy.service';
import { LegacyMongoPowerAdapter } from './legacy-mongo-power.adapter';
import { TelemetryModule } from '../telemetry/telemetry.module';
import {
  TELEMETRY_CONFIG,
  TelemetryConfig,
} from '../telemetry/telemetry.config';
import {
  CANONICAL_POWER_CONFIG,
  CanonicalPowerConfig,
  canonicalPowerConfig,
} from './canonical-power.config';
import { CanonicalPowerHistoryReader } from './canonical-power-history.reader';
import {
  POWER_ASSET_CATALOG,
  POWER_HISTORY_READER,
} from './power-asset-catalog';
import { TelemetryHistoryController } from './telemetry-history.controller';
import {
  LEGACY_POWER_CLIENT,
  LEGACY_POWER_CONFIG,
  LegacyPowerConfig,
  legacyPowerConfig,
} from './legacy-power.config';

@Module({
  imports: [TelemetryModule],
  controllers: [EnergyController, TelemetryHistoryController],
  providers: [
    {
      provide: LEGACY_POWER_CONFIG,
      useFactory: () => legacyPowerConfig(process.env),
    },
    {
      provide: LEGACY_POWER_CLIENT,
      inject: [LEGACY_POWER_CONFIG],
      useFactory: (config: LegacyPowerConfig) =>
        config.uri
          ? new MongoClient(config.uri, {
              serverSelectionTimeoutMS: 5000,
              connectTimeoutMS: 5000,
              socketTimeoutMS: 15000,
              maxPoolSize: 2,
              appName: 'energrid-history-reader',
            })
          : null,
    },
    LegacyMongoPowerAdapter,
    {
      provide: CANONICAL_POWER_CONFIG,
      useFactory: () => canonicalPowerConfig(process.env),
    },
    CanonicalPowerHistoryReader,
    {
      provide: POWER_ASSET_CATALOG,
      inject: [CANONICAL_POWER_CONFIG, LEGACY_POWER_CONFIG, TELEMETRY_CONFIG],
      useFactory: (
        canonical: CanonicalPowerConfig,
        legacy: LegacyPowerConfig,
        telemetry: TelemetryConfig,
      ) =>
        canonical.source === 'telemetry'
          ? {
              configured: Boolean(telemetry.databaseUrl),
              bindings: canonical.bindings,
            }
          : { configured: Boolean(legacy.uri), bindings: legacy.bindings },
    },
    {
      provide: POWER_HISTORY_READER,
      inject: [
        CANONICAL_POWER_CONFIG,
        LegacyMongoPowerAdapter,
        CanonicalPowerHistoryReader,
      ],
      useFactory: (
        config: CanonicalPowerConfig,
        legacy: LegacyMongoPowerAdapter,
        canonical: CanonicalPowerHistoryReader,
      ) => (config.source === 'telemetry' ? canonical : legacy),
    },
    EnergyService,
  ],
})
export class EnergyModule {}
