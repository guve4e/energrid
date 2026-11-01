import { describe, expect, it } from 'vitest';
import { applyDeviceOperationalStateEvent, takePortalSseFrames } from './device-state-events';

describe('Portal device state events', () => {
  it('parses typed SSE frames across chunk boundaries', () => {
    const first = takePortalSseFrames('event: device-state-changed\ndata: {"deviceId":"relay",');
    expect(first.frames).toEqual([]);
    const second = takePortalSseFrames(`${first.remainder}"tenantId":"tenant-demo"}\n\n: keepalive\n\nevent: heartbeat\ndata: {"siteId":"site-home"}\n\n`);
    expect(second.frames).toEqual([
      { event: 'device-state-changed', data: { deviceId: 'relay', tenantId: 'tenant-demo' } },
      { event: 'heartbeat', data: { siteId: 'site-home' } },
    ]);
    expect(second.remainder).toBe('');
  });

  it('updates only the matching device for a newer same-site observation', () => {
    const other = { id: 'other', tenantId: 'tenant-demo', siteId: 'site-home', state: { values: {}, observedAt: null, source: 'none', status: 'unknown' } };
    const target = { id: 'relay', tenantId: 'tenant-demo', siteId: 'site-home', state: { values: { output: true }, observedAt: '2026-11-01T10:00:00.000Z', source: 'remote-http', status: 'online' } };
    const snapshot = { tenant: { id: 'tenant-demo' }, site: { id: 'site-home' }, devices: [target, other] };
    const originalOther = snapshot.devices[1];
    expect(applyDeviceOperationalStateEvent(snapshot, {
      sequence: 1, tenantId: 'tenant-demo', siteId: 'site-home', deviceId: 'relay',
      state: { values: { output: false }, observedAt: '2026-11-01T10:00:01.000Z', source: 'remote-http', status: 'online' },
    })).toBe(true);
    expect(target.state.values.output).toBe(false);
    expect(snapshot.devices[1]).toBe(originalOther);
  });

  it('accepts a newer event sequence when observation timestamps are equal', () => {
    const observedAt = '2026-11-01T10:00:00.000Z';
    const device = { id: 'relay', tenantId: 'tenant-demo', siteId: 'site-home', state: { values: { output: true }, observedAt, source: 'remote-http', status: 'online' } };
    const snapshot = { tenant: { id: 'tenant-demo' }, site: { id: 'site-home' }, devices: [device] };
    const event = {
      sequence: 2, tenantId: 'tenant-demo', siteId: 'site-home', deviceId: 'relay',
      state: { values: { output: false }, observedAt, source: 'remote-http', status: 'online' },
    };
    expect(applyDeviceOperationalStateEvent(snapshot, event, 1)).toBe(true);
    expect(device.state.values.output).toBe(false);
    expect(applyDeviceOperationalStateEvent(snapshot, { ...event, sequence: 1 }, 2)).toBe(false);
  });

  it('rejects cross-site, cross-tenant, unknown-device and stale events', () => {
    const device = { id: 'relay', tenantId: 'tenant-demo', siteId: 'site-home', state: { values: { output: true }, observedAt: '2026-11-01T10:00:01.000Z', source: 'mqtt', status: 'online' } };
    const snapshot = { tenant: { id: 'tenant-demo' }, site: { id: 'site-home' }, devices: [device] };
    const base = { sequence: 1, tenantId: 'tenant-demo', siteId: 'site-home', deviceId: 'relay', state: { values: { output: false }, observedAt: '2026-11-01T10:00:00.000Z', source: 'remote-http', status: 'online' } };
    expect(applyDeviceOperationalStateEvent(snapshot, { ...base, tenantId: 'other-tenant' })).toBe(false);
    expect(applyDeviceOperationalStateEvent(snapshot, { ...base, siteId: 'site-device-lab' })).toBe(false);
    expect(applyDeviceOperationalStateEvent(snapshot, { ...base, deviceId: 'unknown' })).toBe(false);
    expect(applyDeviceOperationalStateEvent(snapshot, base)).toBe(false);
    expect(device.state.values.output).toBe(true);
  });
});
