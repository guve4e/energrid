import { Test } from '@nestjs/testing';
import { EnergyModule } from './energy.module';
import {
  POWER_ASSET_CATALOG,
  POWER_HISTORY_READER,
  PowerAssetCatalog,
} from './power-asset-catalog';
import { Logger } from '@nestjs/common';
import { LegacyMongoPowerAdapter } from './legacy-mongo-power.adapter';
import { CanonicalPowerHistoryReader } from './canonical-power-history.reader';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { TELEMETRY_POOL } from '../telemetry/telemetry.config';
import { TelemetryStore } from '../telemetry/telemetry.store';
import { TelemetryIngestService } from '../telemetry/telemetry-ingest.service';
import { AccessJwtGuard, RoleGuard } from '../auth/auth.guard';

describe('history source composition and safe defaults', () => {
  let original: NodeJS.ProcessEnv;
  beforeEach(() => {
    original = process.env;
    process.env = { ...original };
    for (const key of Object.keys(process.env))
      if (
        key.startsWith('TELEMETRY_') ||
        key.startsWith('LEGACY_TELEMETRY_') ||
        key === 'ENERGY_HISTORY_SOURCE'
      )
        delete process.env[key];
  });
  afterEach(() => {
    process.env = original;
  });

  it('composes a legacy reader with native recording disabled and no PostgreSQL pool', async () => {
    const app = await Test.createTestingModule({
      imports: [EnergyModule, TelemetryModule],
    })
      .overrideGuard(AccessJwtGuard).useValue({ canActivate: () => true })
      .overrideGuard(RoleGuard).useValue({ canActivate: () => true })
      .compile();
    expect(app.get(POWER_HISTORY_READER)).toBeInstanceOf(
      LegacyMongoPowerAdapter,
    );
    expect(app.get(TELEMETRY_POOL)).toBeNull();
    expect(app.get(TelemetryIngestService).status().enabled).toBe(false);
    expect(app.get<PowerAssetCatalog>(POWER_ASSET_CATALOG).configured).toBe(
      false,
    );
    await app.close();
  });
  it('selects a canonical reader explicitly without falling back when recording is disabled', async () => {
    process.env.ENERGY_HISTORY_SOURCE = 'telemetry';
    const app = await Test.createTestingModule({
      imports: [EnergyModule],
    })
      .overrideGuard(AccessJwtGuard).useValue({ canActivate: () => true })
      .overrideGuard(RoleGuard).useValue({ canActivate: () => true })
      .compile();
    expect(app.get(POWER_HISTORY_READER)).toBeInstanceOf(
      CanonicalPowerHistoryReader,
    );
    expect(app.get<PowerAssetCatalog>(POWER_ASSET_CATALOG).configured).toBe(
      false,
    );
    await app.close();
  });
  it('can configure recording separately from the selected legacy history', async () => {
    process.env.TELEMETRY_ENABLED = 'true';
    process.env.TELEMETRY_SPOOL_DIRECTORY =
      '/private/tmp/energrid-unopened-unit-spool';
    process.env.TELEMETRY_DATABASE_URL =
      'postgres://test:test@127.0.0.1:1/not-connected';
    const app = await Test.createTestingModule({
      imports: [EnergyModule],
    })
      .overrideGuard(AccessJwtGuard).useValue({ canActivate: () => true })
      .overrideGuard(RoleGuard).useValue({ canActivate: () => true })
      .compile();
    expect(app.get(POWER_HISTORY_READER)).toBeInstanceOf(
      LegacyMongoPowerAdapter,
    );
    expect(app.get(TelemetryIngestService).status().enabled).toBe(true);
    const store = app.get(TelemetryStore);
    const close = jest.spyOn(store, 'close');
    // compile does not initialize the worker; no network or database access occurs.
    await app.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('can read existing native history with new recording disabled and sanitizes idle pool errors', async () => {
    process.env.ENERGY_HISTORY_SOURCE = 'telemetry';
    process.env.TELEMETRY_DATABASE_URL =
      'postgres://test:test@127.0.0.1:1/not-connected';
    const app = await Test.createTestingModule({
      imports: [EnergyModule],
    })
      .overrideGuard(AccessJwtGuard).useValue({ canActivate: () => true })
      .overrideGuard(RoleGuard).useValue({ canActivate: () => true })
      .compile();
    expect(app.get<PowerAssetCatalog>(POWER_ASSET_CATALOG).configured).toBe(
      true,
    );
    expect(app.get(TelemetryIngestService).status().enabled).toBe(false);
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    app.get(TELEMETRY_POOL).emit('error', new Error('private-host:secret'));
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
    log.mockRestore();
    await app.close();
  });
});
