import type { PortalDevice, PortalState } from '../../portal-state';

export function testDevice(overrides: Partial<PortalDevice> = {}): PortalDevice {
  return {
    id: 'shellyplus1-001:switch:0', tenantId: 'tenant-a', siteId: 'site-a', siteName: 'Virtual Lab',
    displayName: 'Kitchen relay', kind: 'physical', zoneId: 'kitchen', zoneName: 'Kitchen',
    trustStatus: 'approved', capabilities: [{ kind: 'switch', actions: ['turn_on', 'turn_off'] }],
    adapter: { id: 'shelly-1', protocol: 'http', driver: 'shelly-discovered', configured: true },
    control: { status: 'ready', binding: null, reason: 'Authorized' },
    metadata: { component: 'switch:0', physicalId: 'shellyplus1-001' },
    state: { observedAt: '2026-11-03T17:00:00.000Z', source: 'http', status: 'online', values: { output: false } },
    ...overrides,
  } as PortalDevice;
}

export function testState(devices: PortalDevice[] = [testDevice()], siteId = 'site-a'): PortalState {
  return {
    tenant: { id: 'tenant-a', name: 'Tenant' },
    site: { id: siteId, name: 'Virtual Lab', mode: 'lab' },
    devices, zones: [], systems: [],
    voice: { websocketPath: '/voice', provider: 'local' },
  } as PortalState;
}
