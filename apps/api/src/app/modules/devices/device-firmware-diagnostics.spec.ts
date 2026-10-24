import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DeviceFirmwareDiagnosticsService,
  deriveFirmwareHealthEvents,
  parseFirmwareDiagnosticSample,
  type FirmwareDiagnosticSample,
} from './device-firmware-diagnostics';

const deviceId = 'device:upstream-lan:esp8266:324864';
const scope = { tenantId: 'tenant-demo', siteId: 'site-home' };
const sample = (overrides: Partial<FirmwareDiagnosticSample> = {}): FirmwareDiagnosticSample => ({
  schemaVersion: 1,
  deviceId: 'esp8266:324864',
  firmwareVersion: '0.3.0',
  bootSessionId: 'esp8266-324864-1234abcd',
  uptimeMs: 20_000,
  reset: { reason: 'External System', reasonCode: 6, exception: null },
  memory: { freeHeapBytes: 24_000, heapFragmentationPct: 12, largestFreeBlockBytes: 18_000 },
  wifi: { connected: true, rssiDbm: -53, disconnectCount: 0, reconnectCount: 0 },
  sensor: { sampleCount: 10, readFailureCount: 0 },
  ...overrides,
});

describe('firmware diagnostics', () => {
  it('parses only the expected bounded physical identity and preserves reset evidence', () => {
    const source = sample({ reset: { reason: 'Hardware Watchdog', reasonCode: 1, exception: null } });
    expect(parseFirmwareDiagnosticSample(source, source.deviceId)).toEqual(source);
    expect(parseFirmwareDiagnosticSample({ ...source, deviceId: 'esp8266:ffffff' }, source.deviceId)).toBeNull();
    expect(parseFirmwareDiagnosticSample({ ...source, uptimeMs: Number.MAX_SAFE_INTEGER + 1 }, source.deviceId)).toBeNull();
    expect(parseFirmwareDiagnosticSample({ ...source, bootSessionId: 'new-session' }, source.deviceId)).toBeNull();
  });

  it('classifies watchdog, exception, unknown resets and repeated boot sessions without claiming a power fault', () => {
    const at = '2026-10-24T10:00:00.000Z';
    expect(deriveFirmwareHealthEvents(null, sample({ reset: { reason: 'Hardware Watchdog', reasonCode: 1, exception: null } }), at)
      .map(item => item.kind)).toContain('watchdog-reset');
    expect(deriveFirmwareHealthEvents(null, sample({ reset: { reason: 'Exception', reasonCode: 2, exception: {
      cause: 3, epc1: 1, epc2: 0, epc3: 0, address: 10, depc: 0,
    } } }), at).map(item => item.kind)).toContain('exception-reset');
    const unknown = deriveFirmwareHealthEvents(null, sample({ reset: { reason: 'Unknown', reasonCode: 0, exception: null } }), at)
      .find(item => item.kind === 'reset-cause-unknown');
    expect(unknown?.confidence).toBe('possible');
    expect(unknown?.explanation).toContain('do not establish a power-supply fault');
    const previous = { current: sample(), deviceId, tenantId: scope.tenantId, siteId: scope.siteId,
      sampledAt: at, events: [], restartCount10m: 0, connectivity: 'connected' as const };
    const next = sample({ bootSessionId: 'esp8266-324864-1234abce', uptimeMs: 100 });
    expect(deriveFirmwareHealthEvents(previous, next, at).map(item => item.kind)).toContain('reboot-detected');
    const rebootEvents = [
      { id: '1', kind: 'reboot-detected' as const, observedAt: at, bootSessionId: '1', confidence: 'confirmed' as const, summary: '', explanation: '' },
      { id: '2', kind: 'reboot-detected' as const, observedAt: at, bootSessionId: '2', confidence: 'confirmed' as const, summary: '', explanation: '' },
    ];
    expect(deriveFirmwareHealthEvents(previous, next, at, rebootEvents).map(item => item.kind)).toContain('repeated-reboots');
  });

  it('deduplicates repeated evidence, detects reboots, bounds history and recovers after restart with scope isolation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'energrid-fw-diagnostics-'));
    const first = new DeviceFirmwareDiagnosticsService(directory);
    try {
      const at = '2026-10-24T10:00:00.000Z';
      await first.record(scope, deviceId, 'esp8266:324864', sample(), at);
      await first.record(scope, deviceId, 'esp8266:324864', sample(), '2026-10-24T10:00:01.000Z');
      let stored = await first.get(scope, deviceId);
      expect(stored?.events.map(item => item.kind)).not.toContain('reboot-detected');
      const restarted = sample({ bootSessionId: 'esp8266-324864-1234abce', uptimeMs: 100,
        reset: { reason: 'Software Watchdog', reasonCode: 3, exception: null } });
      await first.record(scope, deviceId, 'esp8266:324864', restarted, '2026-10-24T10:00:02.000Z');
    } finally {
      await first.onModuleDestroy();
    }
    const recovered = new DeviceFirmwareDiagnosticsService(directory);
    try {
      const stored = await recovered.get(scope, deviceId);
      expect(stored?.current.bootSessionId).toBe('esp8266-324864-1234abce');
      expect(stored?.events.filter(item => item.kind === 'watchdog-reset')).toHaveLength(1);
      expect(stored?.events.filter(item => item.kind === 'reboot-detected')).toHaveLength(1);
      expect(await recovered.get({ tenantId: 'other', siteId: scope.siteId }, deviceId)).toBeNull();
      expect(await recovered.get(scope, 'another-device')).toBeNull();
      for (let index = 0; index < 110; index++) {
        const session = `esp8266-324864-${index.toString(16).padStart(8, '0')}`;
        await recovered.record(scope, deviceId, 'esp8266:324864', sample({ bootSessionId: session, uptimeMs: 0 }),
          new Date(Date.parse('2026-10-24T10:01:00.000Z') + index * 1000).toISOString());
      }
      expect((await recovered.get(scope, deviceId))?.events.length).toBeLessThanOrEqual(100);
    } finally {
      await recovered.onModuleDestroy();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
