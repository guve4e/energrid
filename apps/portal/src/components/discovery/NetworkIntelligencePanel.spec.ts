import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import NetworkIntelligencePanel from './NetworkIntelligencePanel.vue';

const scopes = [
  { id: 'eero', name: 'Eero', cidr: '192.168.7.0/24', seedIps: [] },
  { id: 'housenet', name: 'HouseNet', cidr: '192.168.1.0/24', seedIps: [] },
];

const snapshot = {
  scanId: 'scan-1', schemaVersion: 2, startedAt: '2026-10-21T10:00:00Z', completedAt: '2026-10-21T10:00:05Z',
  collector: { id: 'mac/en0', host: 'mac', interfaces: ['en0'] },
  scopes: [{ id: 'eero', name: 'Eero', cidr: '192.168.7.0/24', interfaceName: 'en0', complete: true, gatewayIpsObserved: [] }],
  methods: ['neighbor_table', 'nmap_tcp_connect_service_scan', 'shelly_http_rpc'], successes: 2, failures: [], limitations: ['No remote observer'],
  topology: { relationships: [] },
  endpoints: [
    { id: 'shellyplus1-123456789abc', ipAddress: '192.168.7.10', networkZoneId: 'eero', networkZoneName: 'Eero',
      vendor: 'Shelly', model: 'Plus 1', protocol: 'http', status: 'online', discoveredAt: '2026-10-21T10:00:03Z', reason: 'Shelly HTTP API responded',
      macAddress: '12:34:56:78:9a:bc', deviceReportedMacAddress: '12:34:56:78:9a:bc',
      observations: [
        { source: 'tcp', attribute: 'port.80.open', value: true, observedAt: '2026-10-21T10:00:03Z' },
        { source: 'tcp', attribute: 'port.80.service', value: 'http Example 1.2', observedAt: '2026-10-21T10:00:03Z', method: 'nmap_tcp_connect_service_scan' },
        { source: 'http_rpc', attribute: 'shelly.device_id', value: 'shellyplus1-123456789abc', observedAt: '2026-10-21T10:00:03Z' },
      ] },
    { id: 'aa:bb:cc:dd:ee:ff', ipAddress: '192.168.7.20', networkZoneId: 'eero', networkZoneName: 'Eero',
      protocol: 'unknown', status: 'unknown', discoveredAt: '2026-10-21T10:00:04Z', reason: 'Neighbor-table evidence',
      macAddress: 'aa:bb:cc:dd:ee:ff', observations: [] },
  ],
};

const observer = {
  observedAt: '2026-10-21T10:00:00Z', observer: { id: 'mac-dev/darwin', host: 'mac-dev', platform: 'darwin' },
  interfaces: [{ name: 'en0', internal: false, addresses: [{ family: 'IPv4', address: '192.168.7.24', netmask: '255.255.255.0', prefixLength: 24, cidr: '192.168.7.0/24' }] }],
  routes: [{ destination: '0.0.0.0/0', family: 'IPv4', gateway: '192.168.7.1', interfaceName: 'en0', evidence: 'netstat_route_table' }],
  localScopes: [{ cidr: '192.168.7.0/24', interfaceName: 'en0' }],
  configuredScopes: [{ id: 'eero', name: 'Eero', cidr: '192.168.7.0/24', interfaceName: 'en0', reachability: 'on_link', boundedScanEligible: true, reason: 'Route observed.' }],
  capabilities: [{ id: 'neighbor_table_ipv4', available: true, detail: 'ARP is available.' }], limitations: [],
};

describe('NetworkIntelligencePanel', () => {
  it('scans only the explicitly selected network scope', async () => {
    const panel = mount(NetworkIntelligencePanel, { props: { scopes, snapshots: [], latest: null, comparison: null } });
    await panel.get('select[aria-label="Select network scope"]').setValue('housenet');
    await panel.get('button.ni-button-primary').trigger('click');
    expect(panel.emitted('scan')).toEqual([[['housenet']]]);
    panel.unmount();
  });

  it('surfaces real endpoint summary, identity distinctions, service evidence, and diagnostics on demand', async () => {
    const panel = mount(NetworkIntelligencePanel, { props: {
      scopes, snapshots: [snapshot], latest: snapshot, observer,
      nmapCapability: { available: true, enabled: true, version: '7.992' },
      comparison: { fromScanId: 'scan-0', toScanId: 'scan-1', comparableScopes: ['eero'], incompleteScopes: [],
        addedEndpoints: [{ scopeId: 'eero', ipAddress: '192.168.7.10' }], notDetectedEndpoints: [{ scopeId: 'eero', ipAddress: '192.168.7.4' }],
        verifiedAddressChanges: [], ipReuse: [], serviceChanges: [], scopeChanges: [], macChanges: [], gatewayChanges: [],
        identityChanges: [], topologyChanges: { added: [], removed: [] } },
    } });

    expect(panel.get('h1').text()).toBe('Network Intelligence');
    expect(panel.text()).toContain('2');
    expect(panel.text()).toContain('Verified identities');
    expect(panel.text()).toContain('Since the previous scan');
    expect(panel.text()).toContain('1 new');
    expect(panel.text()).toContain('not necessarily offline');
    expect(panel.text()).toContain('192.168.7.10');
    expect(panel.text()).toContain('192.168.7.20');
    expect(panel.text()).toContain('TCP 80');
    expect(panel.text()).toContain('Verified protocol identity');
    expect(panel.find('details.ni-diagnostics').attributes('open')).toBeUndefined();
    expect(panel.find('details.ni-diagnostics').element.hasAttribute('open')).toBe(false);

    await panel.get('details.ni-diagnostics summary').trigger('click');
    expect(panel.text()).toContain('0.0.0.0/0');
    expect(panel.text()).toContain('Nmap 7.992 available');

    await panel.get('button[aria-label="Close endpoint details"]').trigger('click');
    await panel.findAll('button.ni-device-row')[1].trigger('click');
    expect(panel.text()).toContain('Unidentified endpoint');
    expect(panel.text()).toContain('aa:bb:cc:dd:ee:ff');
    panel.unmount();
  });

  it('keeps incomplete scans distinct from empty networks and supports cancellation', async () => {
    const panel = mount(NetworkIntelligencePanel, { props: {
      scopes, snapshots: [], latest: null, comparison: null, busy: true,
    } });
    expect(panel.text()).toContain('Discovering your network');
    await panel.get('button.ni-button-secondary').trigger('click');
    expect(panel.emitted('cancel')).toEqual([[]]);
    panel.unmount();
  });

  it('shows lifecycle counts and opens only the correlated pending or enrolled record', async () => {
    const verifiedKey = 'eero:192.168.7.10:shellyplus1-123456789abc';
    const panel = mount(NetworkIntelligencePanel, { props: {
      scopes, snapshots: [snapshot], latest: snapshot, comparison: null,
      pendingCount: 2, enrolledCount: 1,
      endpointLifecycle: [
        { endpointKey: verifiedKey, stage: 'pending', recordId: 'pending:physical-1' },
        { endpointKey: 'eero:192.168.7.20:aa:bb:cc:dd:ee:ff', stage: 'observed' },
      ],
    } });

    expect(panel.text()).toContain('Pending');
    expect(panel.text()).toContain('Enrolled');
    expect(panel.text()).toContain('2');
    expect(panel.text()).toContain('1');
    expect(panel.text()).toContain('Pending approval');
    await panel.get('button.ni-lifecycle-link').trigger('click');
    expect(panel.emitted('openPending')).toEqual([[]]);
    await panel.get('.ni-lifecycle-context button').trigger('click');
    expect(panel.emitted('openPending')).toEqual([[], ['pending:physical-1']]);
    panel.unmount();
  });

  it('opens endpoint details as a mobile drawer and keeps the list keyboard reachable', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn() }));
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addEventListener: vi.fn() }) });
    const panel = mount(NetworkIntelligencePanel, { props: { scopes, snapshots: [snapshot], latest: snapshot, comparison: null } });
    await nextTick();
    expect(panel.find('.ni-detail').exists()).toBe(false);
    await panel.findAll('button.ni-device-row')[0].trigger('click');

    expect(panel.get('.ni-device-list').attributes('tabindex')).toBe('0');
    expect(panel.get('.ni-detail').attributes('role')).toBe('dialog');
    expect(panel.get('.ni-detail').attributes('aria-modal')).toBe('true');
    expect(panel.find('.ni-detail-scrim').exists()).toBe(true);
    await panel.get('button.ni-detail-scrim').trigger('click');
    expect(panel.find('.ni-detail').exists()).toBe(false);

    panel.unmount();
    vi.unstubAllGlobals();
  });

  it('communicates an empty completed snapshot without claiming the network has no devices', () => {
    const empty = { ...snapshot, endpoints: [], scopes: [{ ...snapshot.scopes[0], complete: false }] };
    const panel = mount(NetworkIntelligencePanel, { props: { scopes, snapshots: [empty], latest: empty, comparison: null } });
    expect(panel.text()).toContain('No endpoints are recorded for this network');
    expect(panel.text()).toContain('does not establish that the network has no devices');
    expect(panel.text()).toContain('Partial coverage');
    panel.unmount();
  });
});
