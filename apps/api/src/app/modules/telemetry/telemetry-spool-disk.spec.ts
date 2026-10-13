import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { TelemetrySpool } from './telemetry-spool';
import {
  TELEMETRY_CONFIG,
  TELEMETRY_SPOOL_FACTORY,
  telemetryConfig,
} from './telemetry.config';
import type { SpoolFactory } from './telemetry-spool';
import { TelemetryModule } from './telemetry.module';
import { testReading } from './telemetry-test.fixture';

it('reopens a real isolated disk buffer, preserves timestamps and refuses a second owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'energrid-spool-test-'));
  const app = await Test.createTestingModule({ imports: [TelemetryModule] })
    .overrideProvider(TELEMETRY_CONFIG)
    .useValue(telemetryConfig({}))
    .compile();
  const config = {
    ...telemetryConfig({}),
    enabled: true,
    spoolDirectory: directory,
  };
  const factory = app.get<SpoolFactory>(TELEMETRY_SPOOL_FACTORY);
  const create = () => new TelemetrySpool(config, factory);
  const first = create(),
    second = create(),
    next = create();
  try {
    await first.enqueue([testReading()]);
    await expect(second.open()).rejects.toThrow('exclusive ownership');
    await first.close();
    expect((await next.peek())!.value).toEqual(testReading());
    expect(next.status().pending).toBe(1);
    await next.finish((await next.peek())!);
    expect(next.status().pending).toBe(0);
  } finally {
    await first.close();
    await second.close();
    await next.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
