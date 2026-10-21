import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import NetworkIntelligencePanel from './NetworkIntelligencePanel.vue';

const scopes = [
  { id: 'eero', name: 'Eero', cidr: '192.168.7.0/24', seedIps: [] },
  { id: 'housenet', name: 'HouseNet', cidr: '192.168.1.0/24', seedIps: [] },
];

describe('NetworkIntelligencePanel', () => {
  it('allows deliberate scope selection and emits only selected scopes', async () => {
    const panel = mount(NetworkIntelligencePanel, { props: { scopes, snapshots: [], latest: null, comparison: null } });
    const checks = panel.findAll('input[type="checkbox"]');
    await checks[1].setValue(false);
    await panel.get('button').trigger('click');
    expect(panel.emitted('scan')).toEqual([[['eero']]]);
    panel.unmount();
  });

  it('shows immutable snapshot metadata, services, provenance, and non-offline comparison wording', () => {
    const snapshot = {
      scanId: 'scan-1', schemaVersion: 1, startedAt: '2026-10-21T10:00:00Z', completedAt: '2026-10-21T10:00:05Z',
      collector: { id: 'mac/en0', host: 'mac', interfaces: ['en0'] },
      scopes: [{ id: 'eero', name: 'Eero', cidr: '192.168.7.0/24', complete: true, gatewayIpsObserved: [] }],
      methods: ['tcp', 'shelly_http_rpc'], successes: 1, failures: [], limitations: ['No remote network observer is configured'],
      topology: { relationships: [] },
      endpoints: [{ id: 'shellyplus1-123456789abc', ipAddress: '192.168.7.10', networkZoneId: 'eero', networkZoneName: 'Eero',
        vendor: 'Shelly', protocol: 'http', status: 'online', discoveredAt: '2026-10-21T10:00:03Z', reason: 'Shelly HTTP API responded',
        macAddress: '12:34:56:78:9a:bc', deviceReportedMacAddress: '12:34:56:78:9a:bc',
        observations: [
          { source: 'tcp', attribute: 'port.80.open', value: true, observedAt: '2026-10-21T10:00:03Z' },
          { source: 'tcp', attribute: 'port.80.service', value: 'http Example 1.2', observedAt: '2026-10-21T10:00:03Z', method: 'nmap_tcp_connect_service_scan' },
        ] }],
    };
    const panel = mount(NetworkIntelligencePanel, { props: {
      scopes, snapshots: [snapshot], latest: snapshot,
      nmapCapability: { available: true, enabled: true, version: '7.95' },
      observer: {
        observedAt: '2026-10-21T10:00:00Z', observer: { id: 'mac-dev/darwin', host: 'mac-dev', platform: 'darwin' },
        interfaces: [{ name: 'en0', internal: false, addresses: [{ family: 'IPv4', address: '10.42.6.10', netmask: '255.255.255.192', prefixLength: 26, cidr: '10.42.6.0/26' }] }],
        routes: [{ destination: '0.0.0.0/0', family: 'IPv4', gateway: '10.42.6.1', interfaceName: 'en0', evidence: 'netstat_route_table' }],
        localScopes: [{ cidr: '10.42.6.0/26', interfaceName: 'en0' }],
        configuredScopes: [{ id: 'local', name: 'Local', cidr: '10.42.6.0/26', interfaceName: 'en0', reachability: 'on_link', boundedScanEligible: true, reason: 'Route observed.' }],
        capabilities: [{ id: 'neighbor_table_ipv4', available: true, detail: 'ARP is available.' }], limitations: [],
      },
      comparison: { fromScanId: 'scan-0', toScanId: 'scan-1', comparableScopes: ['eero'], incompleteScopes: [],
        addedEndpoints: [], notDetectedEndpoints: [{ scopeId: 'eero', ipAddress: '192.168.7.4' }],
        verifiedAddressChanges: [], ipReuse: [], serviceChanges: [], scopeChanges: [], macChanges: [], gatewayChanges: [],
        identityChanges: [], topologyChanges: { added: [], removed: [] } },
    } });

    expect(panel.text()).toContain('192.168.7.10');
    expect(panel.text()).toContain('RPC verified: shellyplus1-123456789abc');
    expect(panel.text()).toContain('80');
    expect(panel.text()).toContain('http Example 1.2 (TCP 80)');
    expect(panel.text()).toContain('executable verified · 7.95');
    expect(panel.text()).toContain('No remote network observer is configured');
    expect(panel.text()).toContain('Current observer · mac-dev · darwin');
    expect(panel.text()).toContain('10.42.6.0/26');
    expect(panel.text()).toContain('192.168.7.0/24');
    expect(panel.text()).toContain('not detected');
    expect(panel.text()).not.toContain('offline endpoint');
    panel.unmount();
  });

  it('offers operator cancellation while a bounded scan is running', async () => {
    const panel = mount(NetworkIntelligencePanel, { props: {
      scopes, snapshots: [], latest: null, comparison: null, busy: true,
    } });
    await panel.get('button:last-of-type').trigger('click');
    expect(panel.emitted('cancel')).toEqual([[]]);
    panel.unmount();
  });
});
