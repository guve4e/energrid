import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import NetworkIntelligencePanel from './NetworkIntelligencePanel.vue';
import { networkEndpointInvestigationKey } from './network-endpoint-investigation';

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

  it('labels an OUI assignment as a network-interface clue, not a device manufacturer', async () => {
    const withVendorClue = { ...snapshot, endpoints: snapshot.endpoints.map(endpoint => endpoint.ipAddress === '192.168.7.20'
      ? { ...endpoint, macVendorClue: { status: 'matched' as const, vendor: 'Espressif Inc.', prefix: '3C:71:BF', assignmentType: 'MA-L', databaseVersion: 'ieee-ma-l-2026-06-05-curated-v1', source: 'https://standards-oui.ieee.org/oui/oui.csv', classification: 'network_interface_vendor_clue' } }
      : endpoint) };
    const panel = mount(NetworkIntelligencePanel, { props: { scopes, snapshots: [withVendorClue], latest: withVendorClue, comparison: null } });
    await panel.findAll('button.ni-device-row')[1].trigger('click');
    expect(panel.text()).toContain('Espressif Inc.');
    expect(panel.text()).toContain('Network-interface/chip assignment; not device manufacturer.');
    expect(panel.text()).toContain('ieee-ma-l-2026-06-05-curated-v1');
    panel.unmount();
  });

  it('offers snapshot-scoped AI investigation only for unidentified endpoints', async () => {
    const panel = mount(NetworkIntelligencePanel, { props: { scopes, snapshots: [snapshot], latest: snapshot, comparison: null } });
    expect(panel.findAll('.ni-device-row')[0].text()).toContain('Shelly');
    expect(panel.findAll('button.ni-device-row')[0].element.getAttribute('aria-pressed')).toBe('true');
    expect(panel.find('.ni-investigate-button').exists()).toBe(false);

    await panel.findAll('button.ni-device-row')[1].trigger('click');
    expect(panel.get('.ni-investigate-button').text()).toBe('Investigate with AI');
    await panel.get('.ni-investigate-button').trigger('click');
    expect(panel.emitted('investigateEndpoint')).toEqual([[
      { scanId: 'scan-1', scopeId: 'eero', ipAddress: '192.168.7.20', endpointId: 'aa:bb:cc:dd:ee:ff' },
    ]]);
    panel.unmount();
  });

  it('distinguishes observed facts, manufacturer clues, and hypotheses in AI results', async () => {
    const key = networkEndpointInvestigationKey('scan-1', 'eero', '192.168.7.20', 'aa:bb:cc:dd:ee:ff');
    const panel = mount(NetworkIntelligencePanel, { props: {
      scopes, snapshots: [snapshot], latest: snapshot, comparison: null,
      endpointInvestigations: { [key]: { loading: false, result: {
        schemaVersion: 1, scanId: 'scan-1', endpointId: 'aa:bb:cc:dd:ee:ff', createdAt: '2026-10-21T10:00:00Z', provider: 'test', model: 'test',
        summary: 'Possible clues only.', identification: { deviceType: null, manufacturer: null, confidence: null, supportingEvidenceIds: [], uncertainty: 'Unknown.' },
        findings: [
          { kind: 'observed_fact', claim: 'TCP port 80 responded.', confidence: 1, supportingEvidenceIds: ['evidence-1'], missingEvidence: [] },
          { kind: 'manufacturer_clue', claim: 'The interface assignment is Espressif Inc.', confidence: 0.7, supportingEvidenceIds: ['evidence-2'], missingEvidence: ['Device maker'] },
          { kind: 'hypothesis', claim: 'It may be an embedded controller.', confidence: 0.5, supportingEvidenceIds: ['evidence-1'], missingEvidence: ['Native identity response'] },
        ], missingEvidence: ['Native identity response'], safeFollowUpChecks: [],
        evidence: [
          { id: 'evidence-1', source: 'tcp', attribute: 'port.80.open', value: true, observedAt: '2026-10-21T10:00:00Z', confidence: 'observed' },
          { id: 'evidence-2', source: 'ieee_oui_database', attribute: 'mac_oui.interface_vendor_clue', value: 'Espressif Inc.', observedAt: '2026-10-21T10:00:00Z', confidence: 'reported' },
        ],
      } } },
    } });
    await panel.findAll('button.ni-device-row')[1].trigger('click');
    expect(panel.text()).toContain('Observed fact');
    expect(panel.text()).toContain('Manufacturer clue');
    expect(panel.text()).toContain('Hypothesis');
    expect(panel.text()).toContain('Missing: Device maker');
    panel.unmount();
  });

  it('selects historical saved evidence and investigates that exact snapshot', async () => {
    const historical = {
      ...snapshot,
      scanId: 'eero-saved-2026-10-20',
      completedAt: '2026-10-20T10:00:05Z',
      endpoints: [{
        id: 'unknown-192.168.7.48', ipAddress: '192.168.7.48', networkZoneId: 'eero', networkZoneName: 'Eero',
        protocol: 'unknown', status: 'unknown', discoveredAt: '2026-10-20T10:00:03Z', reason: 'TCP 80 responded',
        observations: [{ source: 'tcp', attribute: 'port.80.open', value: true, observedAt: '2026-10-20T10:00:03Z' }],
      }],
    };
    const panel = mount(NetworkIntelligencePanel, { props: {
      scopes, snapshots: [snapshot, historical], latest: snapshot, comparison: null,
    } });

    await panel.get('select[aria-label="Select saved network snapshot"]').setValue(historical.scanId);
    expect(panel.text()).toContain('192.168.7.48');
    expect(panel.text()).toContain('10/20/2026');
    expect(panel.findAll('button.ni-device-row')).toHaveLength(1);
    await panel.get('.ni-investigate-button').trigger('click');
    expect(panel.emitted('investigateEndpoint')).toEqual([[
      { scanId: historical.scanId, scopeId: 'eero', ipAddress: '192.168.7.48', endpointId: 'unknown-192.168.7.48' },
    ]]);
    panel.unmount();
  });

  it('requires a separate approval before emitting the fixed read-only HTTP check', async () => {
    const key = networkEndpointInvestigationKey('scan-1', 'eero', '192.168.7.20', 'aa:bb:cc:dd:ee:ff');
    const panel = mount(NetworkIntelligencePanel, { props: {
      scopes, snapshots: [snapshot], latest: snapshot, comparison: null,
      endpointInvestigations: { [key]: { loading: false, result: {
        schemaVersion: 1, scanId: 'scan-1', endpointId: 'aa:bb:cc:dd:ee:ff', createdAt: '2026-10-21T10:00:00Z', provider: 'test', model: 'test',
        summary: 'HTTP headers could help identify the service.', identification: { deviceType: null, manufacturer: null, confidence: null, supportingEvidenceIds: [], uncertainty: 'Unknown.' },
        findings: [], missingEvidence: ['HTTP response headers'], safeFollowUpChecks: [{ action: 'inspect_http_headers', requiresHumanApproval: true }], evidence: [],
      } } },
    } });
    await panel.findAll('button.ni-device-row')[1].trigger('click');
    await panel.get('button.ni-probe-button').trigger('click');
    expect(panel.get('[role="dialog"]').text()).toContain('192.168.7.20:80');
    expect(panel.get('[role="dialog"]').text()).toContain('HEAD /');
    expect(panel.get('[role="dialog"]').text()).toContain('will not follow redirects');
    await panel.get('[role="dialog"] button.ni-button-secondary').trigger('click');
    expect(panel.emitted('probeEndpoint')).toBeUndefined();

    await panel.get('button.ni-probe-button').trigger('click');
    await panel.get('[role="dialog"] button.ni-button-primary').trigger('click');
    expect(panel.emitted('probeEndpoint')).toEqual([[
      { scanId: 'scan-1', scopeId: 'eero', ipAddress: '192.168.7.20', endpointId: 'aa:bb:cc:dd:ee:ff' },
    ]]);
    await panel.setProps({ endpointHttpProbes: { [key]: { loading: false, result: {
      outcome: 'completed', reasonCode: 'http_response_received', ipAddress: '192.168.7.20', method: 'HEAD', path: '/', redirects: 'not_followed',
      statusCode: 302, server: 'fixture-device', contentType: 'text/html', observedAt: '2026-10-21T10:01:00Z',
    } } } });
    expect(panel.text()).toContain('HTTP check evidence · separate from AI interpretation');
    expect(panel.text()).toContain('HTTP 302');
    expect(panel.text()).toContain('Redirects were not followed');
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
