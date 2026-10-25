import { describe, expect, it } from 'vitest';
import { deviceDetailPresentation, relayStateFreshness, relayStateValue } from './device-detail-capabilities';

const sensor = [{ kind: 'temperature', actions: ['read'], unit: 'Cel' }, { kind: 'humidity', actions: ['read'], unit: '%RH' }];
const relay = [{ kind: 'switch', actions: ['turn_on', 'turn_off'] }];
const power = [{ kind: 'power', actions: ['read'], unit: 'W' }];

describe('device details capability presentation', () => {
  it('shows climate measurements for a DHT22 capability', () => {
    expect(deviceDetailPresentation({ capabilities: sensor })).toMatchObject({ climateMetrics: ['temperature', 'humidity'], showElectrical: false, showRelayState: false });
  });
  it('shows relay state only for a relay-only capability', () => {
    expect(deviceDetailPresentation({ capabilities: relay })).toMatchObject({ climateMetrics: [], showElectrical: false, showRelayState: true, showUnknownCapabilities: false });
  });
  it('shows both switching and electrical measurements for a power-monitoring relay', () => {
    expect(deviceDetailPresentation({ capabilities: [...relay, ...power] })).toMatchObject({ climateMetrics: [], showElectrical: true, showRelayState: true });
  });
  it('keeps unknown devices at identity-only capability presentation', () => {
    expect(deviceDetailPresentation({ capabilities: [], supportedCapabilities: [] })).toMatchObject({ climateMetrics: [], showElectrical: false, showRelayState: false, showUnknownCapabilities: true });
  });
  it('retains supported sensor capability while indicating observation approval is missing', () => {
    expect(deviceDetailPresentation({ capabilities: [], supportedCapabilities: sensor })).toMatchObject({ climateMetrics: ['temperature', 'humidity'], measurementApprovalNeeded: ['temperature', 'humidity'] });
  });
  it('keeps authorized read sensors visible when the support list is incomplete', () => {
    expect(deviceDetailPresentation({
      capabilities: [{ kind: 'temperature', actions: ['read'] }],
      supportedCapabilities: relay,
    })).toMatchObject({ climateMetrics: ['temperature'], measurementApprovalNeeded: [], showRelayState: true });
  });
  it('marks an old relay state stale without interpreting it as current', () => {
    expect(relayStateFreshness('online', '2026-10-24T11:00:00.000Z', Date.parse('2026-10-24T12:00:00.000Z'))).toBe('stale');
    expect(relayStateValue({ on: true })).toBe(true);
  });
  it('combines climate and power on devices with multiple verified capabilities', () => {
    expect(deviceDetailPresentation({ capabilities: [...sensor, ...power] })).toMatchObject({ climateMetrics: ['temperature', 'humidity'], showElectrical: true, showRelayState: false });
  });
});
