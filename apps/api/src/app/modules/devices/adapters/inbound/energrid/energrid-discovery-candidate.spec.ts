import { energridDiscoveryCandidate } from './energrid-discovery-candidate';
import type { NetworkDiscoveredDevice } from '../../../device-registry.types';

function discovered(ipAddress = '192.168.1.198', scope = 'upstream-lan'): NetworkDiscoveredDevice {
  const observedAt = new Date().toISOString();
  return {
    id: 'esp8266:324864', ipAddress, networkZoneId: scope, networkZoneName: 'Upstream LAN',
    protocol: 'http', confidence: 1, status: 'online', discoveredAt: observedAt,
    reason: 'Verified HTTP device identity',
    observations: [
      { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt, scopeId: scope, method: 'GET /api/v1/identity' },
      { source: 'http_identity', attribute: 'identity.device_id', value: 'esp8266:324864', observedAt, scopeId: scope, method: 'GET /api/v1/identity' },
      { source: 'http_identity', attribute: 'device.model', value: 'Energrid ESP8266 DHT22', observedAt, scopeId: scope, method: 'GET /api/v1/identity' },
      { source: 'http_identity', attribute: 'firmware.version', value: '0.2.0', observedAt, scopeId: scope, method: 'GET /api/v1/identity' },
      { source: 'http_identity', attribute: 'device.capability', value: 'temperature', observedAt, scopeId: scope, method: 'GET /api/v1/identity' },
      { source: 'http_identity', attribute: 'device.capability', value: 'humidity', observedAt, scopeId: scope, method: 'GET /api/v1/identity' },
    ],
  };
}

describe('Energrid discovery candidate adapter', () => {
  it('projects only verified identity into a pending HTTP candidate with read-only evidence', () => {
    const candidate = energridDiscoveryCandidate(discovered());
    expect(candidate).toMatchObject({
      id: 'device:upstream-lan:esp8266:324864', protocol: 'http', driver: 'energrid-esp8266',
      capabilities: ['temperature', 'humidity'], target: 'http://192.168.1.198/api/v1/status',
      metadata: { physicalId: 'esp8266:324864', networkScope: 'upstream-lan', observationApprovalRequired: true },
    });
  });

  it('keeps the same stable candidate on DHCP change and separates network scopes', () => {
    const original = energridDiscoveryCandidate(discovered('192.168.1.198'))!;
    const changedAddress = energridDiscoveryCandidate(discovered('192.168.1.211'))!;
    const otherScope = energridDiscoveryCandidate(discovered('192.168.1.198', 'guest-lan'))!;
    expect(changedAddress.id).toBe(original.id);
    expect(changedAddress.target).toContain('192.168.1.211');
    expect(otherScope.id).not.toBe(original.id);
  });

  it('rejects unverified, mismatched, or conflicted endpoint evidence', () => {
    const device = discovered();
    expect(energridDiscoveryCandidate({ ...device, identityConflict: { reason: 'multiple_macs_for_endpoint', macAddresses: ['aa', 'bb'] } })).toBeNull();
    expect(energridDiscoveryCandidate({ ...device, observations: device.observations?.filter(item => item.attribute !== 'identity.verified') })).toBeNull();
    expect(energridDiscoveryCandidate({ ...device, id: 'esp8266:000001' })).toBeNull();
  });
});
