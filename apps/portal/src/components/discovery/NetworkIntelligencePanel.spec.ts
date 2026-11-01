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
  scanId: 'scan-1', schemaVersion: 2, ownership: { tenantId: 'tenant-demo', siteId: 'site-home' },
  startedAt: '2026-10-21T10:00:00Z', completedAt: '2026-10-21T10:00:05Z',
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
  it('reports 14 attempted targets separately from the six endpoints with response evidence', async () => {
    const fullScan = {
      ...snapshot,
      scopes: [{ id: 'eero', name: 'Eero', cidr: '192.168.7.0/24', complete: true, gatewayIpsObserved: [],
        collectionStages: { hostDiscovery: { targetCount: 14, hostsReported: 5 }, serviceEnrichment: { targetCount: 14, hostsReported: 6 } } }],
      endpoints: Array.from({ length: 14 }, (_, index) => ({
        id: `192.168.7.${index + 2}`, ipAddress: `192.168.7.${index + 2}`, networkZoneId: 'eero', networkZoneName: 'Eero',
        protocol: index < 3 ? 'http' : 'unknown', status: index < 6 ? 'online' : 'unknown',
        discoveredAt: '2026-10-21T10:00:04Z', reason: index < 6 ? 'Response evidence recorded' : 'Neighbor evidence only',
        observations: index < 6 ? [{ source: 'tcp', attribute: `port.${80 + index}.closed`, value: false, observedAt: '2026-10-21T10:00:04Z' },
          ...(index === 0 ? [{ source: 'http_rpc', attribute: 'shelly.device_id', value: `192.168.7.${index + 2}`, observedAt: '2026-10-21T10:00:04Z' },
            { source: 'http_rpc', attribute: 'identity.verified', value: true, observedAt: '2026-10-21T10:00:04Z' }] : [])] : [],
      })),
    };
    const panel = mount(NetworkIntelligencePanel, {
      props: { scopes, snapshots: [fullScan], latest: fullScan, comparison: null, observer },
    });
    await panel.get('details.ni-diagnostics summary').trigger('click');
    expect(panel.text()).toContain('14 attempted host target(s); 5 host-discovery responses; 14 service-enrichment targets, 6 service-enrichment responses; 6 endpoints with network-response evidence; 1 verified protocol identities.');
    expect(panel.text()).toContain('Endpoint records without direct response evidence remain remembered observations, not confirmed responders.');
    panel.unmount();
  });

  it('distinguishes a selected-device verification from a subnet scan and exposes counts by evidence type', async () => {
    const verification = {
      ...snapshot,
      scanId: 'verification-1',
      methods: ['operator_selected_shelly_read_only_rpc'],
      successes: 1,
      scopes: [{ id: 'eero', name: 'Eero', cidr: '192.168.7.0/24', complete: false, gatewayIpsObserved: [],
        collectionStages: { hostDiscovery: { targetCount: 0, hostsReported: 0 }, serviceEnrichment: { targetCount: 1, hostsReported: 1 } } }],
      endpoints: [{ ...snapshot.endpoints[0], networkZoneId: 'eero' }, {
        id: '192.168.7.9', ipAddress: '192.168.7.9', networkZoneId: 'eero', networkZoneName: 'Eero',
        protocol: 'unknown', status: 'unknown', discoveredAt: '2026-10-21T10:00:04Z', reason: 'Attempted target only', observations: [],
      }],
    };
    const panel = mount(NetworkIntelligencePanel, {
      props: { scopes, snapshots: [verification], latest: verification, comparison: null, observer },
    });
    expect(panel.text()).toContain('Selected-device verification');
    expect(panel.text()).toContain('Last selected-device verification');
    await panel.get('details.ni-diagnostics summary').trigger('click');
    expect(panel.text()).toContain('0 attempted host target(s); 0 host-discovery responses; 1 service-enrichment targets, 1 service-enrichment responses; 1 endpoints with network-response evidence; 1 verified protocol identities.');
    expect(panel.text()).toContain('Endpoint records without direct response evidence remain remembered observations, not confirmed responders.');
    panel.unmount();

    const noScan = mount(NetworkIntelligencePanel, { props: { scopes, snapshots: [], latest: null, comparison: null } });
    expect(noScan.text()).toContain('No saved scan for this site');
    expect(noScan.text()).not.toContain('No scan yet');
    noScan.unmount();

    const labOnly = { ...snapshot, scopes: [{ id: 'lab', name: 'Virtual Lab', cidr: '172.30.250.0/28', complete: true, gatewayIpsObserved: [] }] };
    const otherNetwork = mount(NetworkIntelligencePanel, {
      props: { scopes: [...scopes, { id: 'lab', name: 'Virtual Lab', cidr: '172.30.250.0/28', seedIps: [] }], snapshots: [labOnly], latest: labOnly, comparison: null },
    });
    await otherNetwork.get('select[aria-label="Select network scope"]').setValue('eero');
    expect(otherNetwork.text()).toContain('No saved scan for this network');
    expect(otherNetwork.text()).toContain('Latest saved evidence belongs to a different network');
    otherNetwork.unmount();
  });

  it('shows exact enrolled Shelly components as reconciliation proposals without treating MQTT as identity', async () => {
    const proposal = {
      deviceId: 'shellypro2pm-ec6260888084:switch:0', displayName: 'Washer / bathroom fan', room: 'Bathroom',
      physicalId: 'shellypro2pm-ec6260888084', component: 'switch:0', evidenceScanId: 'site-observer-0123456789',
      observerId: 'pi-housenet', observedAt: '2026-10-27T07:40:00Z', endpoint: '192.168.1.166',
      physicalInventoryId: '8e15ec60-a22b-4f8c-ab09-5e61d44030f9', identityVerifiedAt: '2026-10-27T07:39:00Z',
      componentVerifiedAt: '2026-10-27T07:40:00Z', evidenceFresh: true,
      model: 'SPSW-202PE16EU', firmwareVersion: '2.0.0', verifiedMeasurementFields: ['power', 'energy_import_total'],
      currentIdentitySource: 'mqtt', currentDriver: 'shelly-discovered', mqttTopicRequiresOperatorBinding: true as const,
    };
    const panel = mount(NetworkIntelligencePanel, { props: {
      scopes, snapshots: [], latest: null, comparison: null,
      siteLocalEvidenceImport: { status: 'reconciliation_review_required', scanId: proposal.evidenceScanId,
        observerId: proposal.observerId, physicalId: proposal.physicalId,
        reconciliationProposals: [proposal], reconciliationConflicts: [], historicalComponentConflicts: [] },
    } });
    expect(panel.text()).toContain('Evidence is operator-attested');
    expect(panel.text()).toContain('Bathroom · switch:0');
    expect(panel.text()).toContain('power, energy_import_total');
    expect(panel.text()).toContain('8e15ec60-a22b-4f8c-ab09-5e61d44030f9');
    expect(panel.text()).toContain('Exact event topic requires separate operator binding');
    expect(panel.text()).toContain('Existing enrollment, room, approvals');
    await panel.findAll('button').find(button => button.text().includes('Record verified identity'))!.trigger('click');
    expect(panel.emitted('reconcileSiteLocalEvidence')).toEqual([[{
      scanId: proposal.evidenceScanId, deviceId: proposal.deviceId, component: proposal.component,
    }]]);
    panel.unmount();
  });

  it('labels accepted stale evidence historical and keeps approval freshness separate', () => {
    const proposal = {
      deviceId: 'shellypro2pm-ec6260888084:switch:1', displayName: 'Output 1', room: 'Unknown',
      physicalId: 'shellypro2pm-ec6260888084', component: 'switch:1', evidenceScanId: 'site-observer-0123456789',
      observerId: 'pi-housenet', observedAt: '2026-10-26T07:40:00Z', endpoint: '192.168.1.166',
      physicalInventoryId: '8e15ec60-a22b-4f8c-ab09-5e61d44030f9', identityVerifiedAt: '2026-10-26T07:39:00Z',
      componentVerifiedAt: '2026-10-26T07:40:00Z', evidenceFresh: false,
      model: 'SPSW-202PE16EU', firmwareVersion: '2.0.0', verifiedMeasurementFields: ['power'],
      currentIdentitySource: 'mqtt', currentDriver: 'shelly-discovered', mqttTopicRequiresOperatorBinding: true as const,
    };
    const panel = mount(NetworkIntelligencePanel, { props: {
      scopes, snapshots: [], latest: null, comparison: null,
      siteLocalEvidenceImport: { status: 'reconciliation_review_required', scanId: proposal.evidenceScanId,
        observerId: proposal.observerId, physicalId: proposal.physicalId,
        reconciliationProposals: [proposal], reconciliationConflicts: [], historicalComponentConflicts: [] },
    } });
    expect(panel.text()).toContain('Historical; refresh required before approving measurements');
    expect(panel.text()).toContain('Record historical identity evidence');
    panel.unmount();
  });

  it('displays structured reconciliation rejection codes without hiding the safe explanation', () => {
    const panel = mount(NetworkIntelligencePanel, { props: {
      scopes, snapshots: [], latest: null, comparison: null,
      siteLocalEvidenceImport: { status: 'pending_review', scanId: 'site-observer-report', observerId: 'pi-housenet',
        physicalId: 'shellypro2pm-ec6260888084', reconciliationProposals: [], historicalComponentConflicts: [],
        reconciliationConflicts: [{ deviceId: 'shellypro2pm-ec6260888084:switch:0', component: 'switch:0',
          reasonCode: 'installation_missing', reason: 'The scoped logical device record has no durable installation record; no metadata was changed.' }] },
    } });
    expect(panel.text()).toContain('[installation_missing]');
    expect(panel.text()).toContain('no durable installation record');
    expect(panel.text()).toContain('No exact enrolled component matched');
    panel.unmount();
  });

  it('lets an administrator reopen reconciliation review from a saved site-local RPC snapshot', async () => {
    const scanId = 'site-observer-2aec6d8b2d4d25f397a572203264edd0a388de00';
    const endpointId = 'shellypro2pm-ec6260888084';
    const saved = {
      ...snapshot, scanId, scopes: [{ id: 'housenet', name: 'Upstream LAN', cidr: '192.168.1.0/24', complete: false, gatewayIpsObserved: [] }],
      endpoints: [{ id: endpointId, ipAddress: '192.168.1.166', networkZoneId: 'housenet', networkZoneName: 'Upstream LAN',
        vendor: 'Shelly', model: 'SPSW-202PE16EU', protocol: 'http', status: 'online', discoveredAt: '2026-10-27T09:39:36Z',
        reason: 'Site-local RPC report', components: [{ component: 'switch:0', channel: 0 }, { component: 'switch:1', channel: 1 }],
        observations: [
          { source: 'http_identity', attribute: 'identity.device_id', value: endpointId, observedAt: '2026-10-27T09:39:00Z' },
          { source: 'site_local_http_rpc', attribute: 'observer.identity', value: 'pi-housenet', observedAt: '2026-10-27T09:39:00Z' },
          { source: 'site_local_http_rpc', attribute: 'shelly.component_status', value: 'switch:0', observedAt: '2026-10-27T09:39:10Z' },
        ],
      }],
    };
    const panel = mount(NetworkIntelligencePanel, { props: {
      scopes: [{ id: 'housenet', name: 'Upstream LAN', cidr: '192.168.1.0/24', seedIps: [] }],
      snapshots: [saved], latest: saved, comparison: null,
      endpointLifecycle: [{ endpointKey: `housenet:192.168.1.166:${endpointId}`, snapshotId: scanId, stage: 'enrolled', relatedRecords: 2 }],
    } });
    expect(panel.text()).toContain('2 enrolled logical records share this verified physical identity');
    await panel.findAll('button').find(button => button.text().includes('Review saved RPC evidence'))!.trigger('click');
    expect(panel.emitted('reviewSavedSiteLocalEvidence')).toEqual([[scanId]]);
    panel.unmount();
  });

  it('shows unscoped v2 history as read-only evidence without offering investigation actions', async () => {
    const { ownership: _ownership, ...legacySnapshot } = snapshot;
    const panel = mount(NetworkIntelligencePanel, {
      props: { scopes, snapshots: [legacySnapshot], latest: legacySnapshot, comparison: null },
    });
    expect(panel.text()).toContain('Legacy snapshot · ownership was not recorded');
    await panel.findAll('button.ni-device-row')[1].trigger('click');
    expect(panel.text()).toContain('Investigation and follow-up actions are unavailable for unscoped legacy evidence');
    expect(panel.find('button.ni-investigate-button').exists()).toBe(false);
    panel.unmount();
  });

  it('scans only the explicitly selected network scope', async () => {
    const panel = mount(NetworkIntelligencePanel, { props: { scopes, snapshots: [], latest: null, comparison: null } });
    await panel.get('select[aria-label="Select network scope"]').setValue('housenet');
    await panel.get('button.ni-button-primary').trigger('click');
    expect(panel.emitted('scan')).toEqual([[['housenet']]]);
    panel.unmount();
  });

  it('surfaces real endpoint summary, identity distinctions, service evidence, and diagnostics on demand', async () => {
    const baseline = { ...snapshot, scanId: 'scan-0', completedAt: '2026-10-20T10:00:05Z', endpoints: [
      { ...snapshot.endpoints[1], id: 'previous-endpoint', ipAddress: '192.168.7.4', discoveredAt: '2026-10-20T10:00:04Z' },
    ] };
    const panel = mount(NetworkIntelligencePanel, { props: {
      scopes, snapshots: [snapshot, baseline], latest: snapshot, observer,
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

    expect(panel.find('a[href^="http://192.168.7.10"]').exists()).toBe(false);
    await panel.get('button[aria-label="Close endpoint details"]').trigger('click');
    await panel.findAll('button.ni-device-row')[1].trigger('click');
    expect(panel.text()).toContain('Unidentified endpoint');
    expect(panel.text()).toContain('aa:bb:cc:dd:ee:ff');
    panel.unmount();
  });

  it('opens exact new, changed and not-detected endpoint deltas from the summary', async () => {
    const verified = snapshot.endpoints[0];
    const previous = { ...snapshot, scanId: 'scan-before', completedAt: '2026-10-20T10:00:05Z', endpoints: [
      { ...verified, ipAddress: '192.168.7.9', discoveredAt: '2026-10-20T10:00:02Z' },
      { ...snapshot.endpoints[1], id: 'old-host', ipAddress: '192.168.7.30', hostname: 'old-host', discoveredAt: '2026-10-20T10:00:04Z' },
    ] };
    const added = { ...snapshot.endpoints[1], id: 'new-host', ipAddress: '192.168.7.31', hostname: 'new-device',
      discoveredAt: '2026-10-21T10:00:04Z', confidence: 0.8,
      observations: [{ source: 'tcp', attribute: 'port.443.open', value: true, observedAt: '2026-10-21T10:00:04Z', method: 'bounded_tcp_scan' }] };
    const current = { ...snapshot, endpoints: [{ ...verified, ipAddress: '192.168.7.11', discoveredAt: '2026-10-21T10:00:03Z' }, added] };
    const comparison = {
      fromScanId: previous.scanId, toScanId: current.scanId, comparableScopes: ['eero'], incompleteScopes: [],
      addedEndpoints: [{ scopeId: 'eero', ipAddress: added.ipAddress }],
      notDetectedEndpoints: [{ scopeId: 'eero', ipAddress: '192.168.7.30' }],
      verifiedAddressChanges: [{ identity: verified.id, from: '192.168.7.9', to: '192.168.7.11' }],
      ipReuse: [], serviceChanges: [], scopeChanges: [], macChanges: [], hostnameChanges: [], gatewayChanges: [], identityChanges: [],
      topologyChanges: { added: [], removed: [] },
    };
    const panel = mount(NetworkIntelligencePanel, { props: {
      scopes, snapshots: [current, previous], latest: current, comparison,
    } });

    const summaryButtons = panel.findAll('.ni-change-summary button');
    expect(summaryButtons.map(button => button.text())).toEqual(['1 new', '1 changed', '1 not detected · not necessarily offline']);

    await summaryButtons[0].trigger('click');
    expect(panel.get('.ni-delta-list').text()).toContain('new-device');
    expect(panel.get('.ni-delta-list').text()).toContain('192.168.7.31');
    expect(panel.get('.ni-delta-list').text()).toContain('bounded_tcp_scan');
    await summaryButtons[1].trigger('click');
    expect(panel.get('.ni-delta-list').text()).toContain('Verified IP address: 192.168.7.9 → 192.168.7.11');
    expect(panel.get('.ni-delta-list').text()).toContain('Previous · 192.168.7.9');
    expect(panel.get('.ni-delta-list').text()).toContain('Current · 192.168.7.11');
    await summaryButtons[2].trigger('click');
    expect(panel.get('.ni-delta-list').text()).toContain('old-host');
    expect(panel.get('.ni-delta-list').text()).toContain('Not detected in the latest scan; current status is unknown');
    panel.unmount();
  });

  it('puts evidence-backed gateway role ahead of the unidentified-device label without claiming hardware identity', async () => {
    const withGatewayRole = { ...snapshot, networkRoles: [{
      id: 'role:gateway:eero:192.168.7.20', role: 'default_gateway' as const, label: 'Observed default gateway' as const,
      scopeId: 'eero', scopeName: 'Eero', ipAddress: '192.168.7.20', observedAt: '2026-10-21T10:00:00Z',
      observer: { id: 'observer/mac', host: 'macbook', interfaceName: 'en0' }, routeDestination: '0.0.0.0/0', routeEvidence: 'netstat_route_table',
    }] };
    const panel = mount(NetworkIntelligencePanel, { props: { scopes, snapshots: [withGatewayRole], latest: withGatewayRole, comparison: null } });
    await panel.findAll('button.ni-device-row')[1].trigger('click');
    expect(panel.text()).toContain('Observed default gateway');
    expect(panel.text()).toContain('Default route 0.0.0.0/0 from macbook on en0');
    expect(panel.text()).toContain('Router make, model, and device identity are not established.');
    expect(panel.text()).toContain('Verified protocol identity');
    expect(panel.text()).toContain('Not established');
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

  it('labels a first scan as the baseline when there is no previous comparable snapshot', () => {
    const panel = mount(NetworkIntelligencePanel, { props: { scopes, snapshots: [snapshot], latest: snapshot, comparison: null } });
    expect(panel.text()).toContain('No previous comparable scan is available for this scope. This snapshot is the baseline.');
    expect(panel.find('.ni-change-summary').exists()).toBe(false);
    panel.unmount();
  });

  it('shows lifecycle counts and opens only the correlated pending or enrolled record', async () => {
    const verifiedKey = 'eero:192.168.7.10:shellyplus1-123456789abc';
    const panel = mount(NetworkIntelligencePanel, { props: {
      scopes, snapshots: [snapshot], latest: snapshot, comparison: null,
      pendingCount: 2, enrolledCount: 1,
      endpointLifecycle: [
        { endpointKey: verifiedKey, snapshotId: snapshot.scanId, stage: 'pending', recordId: 'pending:physical-1' },
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
      endpointIdentityRefreshes: {}, endpointHttpProbes: {},
      endpointInvestigations: { [key]: { loading: false, result: {
        schemaVersion: 1, scanId: 'scan-1', endpointId: 'aa:bb:cc:dd:ee:ff', createdAt: '2026-10-21T10:00:00Z', provider: 'test', model: 'test',
        summary: 'HTTP headers could help identify the service.', identification: { deviceType: null, manufacturer: null, confidence: null, supportingEvidenceIds: [], uncertainty: 'Unknown.' },
        findings: [], missingEvidence: ['HTTP response headers'], safeFollowUpChecks: [{ action: 'inspect_http_headers', requiresHumanApproval: true }], evidence: [],
      } } },
    } });
    await panel.findAll('button.ni-device-row')[1].trigger('click');
    await panel.get('button.ni-probe-button').trigger('click');
    expect(panel.text()).toContain('Refresh identity required');
    expect(panel.get('[role="dialog"]').text()).toContain('192.168.7.20');
    expect(panel.get('[role="dialog"]').text()).toContain('one ARP identity request');
    await panel.get('[role="dialog"] button.ni-button-secondary').trigger('click');
    expect(panel.emitted('refreshEndpointIdentity')).toBeUndefined();

    await panel.get('button.ni-probe-button').trigger('click');
    await panel.get('[role="dialog"] button.ni-button-primary').trigger('click');
    expect(panel.emitted('refreshEndpointIdentity')).toEqual([[
      { scanId: 'scan-1', scopeId: 'eero', ipAddress: '192.168.7.20', endpointId: 'aa:bb:cc:dd:ee:ff' },
    ]]);
    expect(panel.find('.ni-investigation-evidence summary').text()).toBe('Evidence');

    // Vue Test Utils infers setProps from the initial literal, so cast only this
    // dynamic update boundary for component props that the test supplies later.
    const updateEvidenceProps = (props: { endpointIdentityRefreshes?: Record<string, unknown>; endpointHttpProbes?: Record<string, unknown> }) =>
      panel.setProps(props as never);
    await updateEvidenceProps({ endpointIdentityRefreshes: { [key]: { loading: false, result: {
      outcome: 'verified', reasonCode: 'historical_mac_matched', refreshId: 'refresh-once', action: 'http_head_root', source: 'direct_arp_reply', method: 'single_target_nmap_arp_ping', scopeId: 'eero',
      ipAddress: '192.168.7.20', historicalMac: 'aa:bb:cc:dd:ee:ff', observedMac: 'aa:bb:cc:dd:ee:ff',
      observedAt: new Date().toISOString(), interfaceName: 'en0',
    } } } });
    expect(panel.text()).toContain('Current MAC matches the saved MAC');
    await panel.findAll('button.ni-probe-button').find(button => button.text() === 'Review HTTP headers')!.trigger('click');
    expect(panel.get('[role="dialog"]').text()).toContain('192.168.7.20:80');
    expect(panel.get('[role="dialog"]').text()).toContain('HEAD /');
    expect(panel.get('[role="dialog"]').text()).toContain('will not follow redirects');
    await panel.get('[role="dialog"] button.ni-button-secondary').trigger('click');
    expect(panel.emitted('probeEndpoint')).toBeUndefined();

    await panel.findAll('button.ni-probe-button').find(button => button.text() === 'Review HTTP headers')!.trigger('click');
    await panel.get('[role="dialog"] button.ni-button-primary').trigger('click');
    expect(panel.emitted('probeEndpoint')).toEqual([[
      { scanId: 'scan-1', scopeId: 'eero', ipAddress: '192.168.7.20', endpointId: 'aa:bb:cc:dd:ee:ff', refreshId: 'refresh-once' },
    ]]);
    await updateEvidenceProps({ endpointHttpProbes: { [key]: { loading: false, result: {
      outcome: 'completed', reasonCode: 'http_response_received', ipAddress: '192.168.7.20', method: 'HEAD', path: '/', redirects: 'not_followed',
      statusCode: 302, server: 'fixture-device', contentType: 'text/html', observedAt: '2026-10-21T10:01:00Z',
    } } } });
    expect(panel.text()).toContain('HTTP check evidence · separate from AI interpretation');
    expect(panel.text()).toContain('HTTP 302');
    expect(panel.text()).toContain('Redirects were not followed');
    panel.unmount();
  });

  it('does not offer an HTTP check when the refreshed MAC changed', async () => {
    const key = networkEndpointInvestigationKey('scan-1', 'eero', '192.168.7.20', 'aa:bb:cc:dd:ee:ff');
    const panel = mount(NetworkIntelligencePanel, { props: {
      scopes, snapshots: [snapshot], latest: snapshot, comparison: null,
      endpointInvestigations: { [key]: { loading: false, result: {
        schemaVersion: 1, scanId: 'scan-1', endpointId: 'aa:bb:cc:dd:ee:ff', createdAt: '2026-10-21T10:00:00Z', provider: 'test', model: 'test',
        summary: 'HTTP headers may help.', identification: { deviceType: null, manufacturer: null, confidence: null, supportingEvidenceIds: [], uncertainty: 'Unknown.' },
        findings: [], missingEvidence: [], safeFollowUpChecks: [{ action: 'inspect_http_headers', requiresHumanApproval: true }], evidence: [],
      } } },
      endpointIdentityRefreshes: { [key]: { loading: false, result: {
        outcome: 'changed', reasonCode: 'identity_changed', source: 'direct_arp_reply', method: 'single_target_nmap_arp_ping', scopeId: 'eero', ipAddress: '192.168.7.20',
        historicalMac: 'aa:bb:cc:dd:ee:ff', observedMac: '10:20:30:40:50:60', observedAt: '2026-10-21T10:01:00Z',
      } } },
    } });
    await panel.findAll('button.ni-device-row')[1].trigger('click');
    expect(panel.text()).toContain('MAC changed at this address');
    expect(panel.text()).toContain('Refresh identity required');
    expect(panel.findAll('button.ni-probe-button')).toHaveLength(1);
    expect(panel.findAll('button.ni-probe-button')[0].text()).toBe('Refresh identity');
    expect(panel.emitted('probeEndpoint')).toBeUndefined();
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
