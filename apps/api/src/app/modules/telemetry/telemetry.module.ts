import { Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { ClassicLevel } from 'classic-level';
import {
  TELEMETRY_CONFIG,
  TELEMETRY_POOL,
  TELEMETRY_SPOOL_FACTORY,
  TelemetryConfig,
  telemetryConfig,
} from './telemetry.config';
import { TelemetryStore } from './telemetry.store';
import { TelemetryIngestService } from './telemetry-ingest.service';
import { TelemetryRollupService } from './telemetry-rollup.service';
import { TelemetrySpool } from './telemetry-spool';

@Module({
  providers: [
    {
      provide: TELEMETRY_SPOOL_FACTORY,
      useValue: (directory: string) =>
        new ClassicLevel<string, unknown>(directory, { valueEncoding: 'json' }),
    },
    {
      provide: TELEMETRY_CONFIG,
      useFactory: () => telemetryConfig(process.env),
    },
    {
      provide: TELEMETRY_POOL,
      inject: [TELEMETRY_CONFIG],
      useFactory: (config: TelemetryConfig) => {
        if (!config.databaseUrl) return null;
        const pool = new Pool({
          connectionString: config.databaseUrl!,
          max: 3,
          connectionTimeoutMillis: 5000,
          query_timeout: 15_000,
          statement_timeout: 10_000,
          application_name: 'energrid-telemetry',
          options: '-c timezone=UTC',
        });
        pool.on('error', () =>
          new Logger('TelemetryPool').error(
            'Telemetry database connection failed.',
          ),
        );
        return pool;
      },
    },
    TelemetryStore,
    TelemetrySpool,
    TelemetryIngestService,
    TelemetryRollupService,
  ],
  exports: [TELEMETRY_CONFIG, TelemetryStore, TelemetryIngestService],
})
export class TelemetryModule implements OnModuleDestroy {
  constructor(
    private readonly store: TelemetryStore,
    private readonly spool: TelemetrySpool,
  ) {}
  // Provider shutdown drains writes and stops rollups before this module closes their pool.
  async onModuleDestroy() {
    try {
      await this.spool.close();
    } finally {
      await this.store.close();
    }
  }
}
