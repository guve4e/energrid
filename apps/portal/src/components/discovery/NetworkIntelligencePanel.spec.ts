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
      methods: ['tcp', 'shelly_http_rpc'], successes: 1, failures: [], limitations: ['No remote collector'],
      topology: { relationships: [] },
      endpoints: [{ id: 'shellyplus1-123456789abc', ipAddress: '192.168.7.10', networkZoneId: 'eero', networkZoneName: 'Eero',
        vendor: 'Shelly', protocol: 'http', status: 'online', discoveredAt: '2026-10-21T10:00:03Z', reason: 'Shelly HTTP API responded',
        macAddress: '12:34:56:78:9a:bc', deviceReportedMacAddress: '12:34:56:78:9a:bc',
        observations: [{ source: 'tcp', attribute: 'port.80.open', value: true, observedAt: '2026-10-21T10:00:03Z' }] }],
    };
    const panel = mount(NetworkIntelligencePanel, { props: {
      scopes, snapshots: [snapshot], latest: snapshot,
      comparison: { fromScanId: 'scan-0', toScanId: 'scan-1', comparableScopes: ['eero'], incompleteScopes: [],
        addedEndpoints: [], notDetectedEndpoints: [{ scopeId: 'eero', ipAddress: '192.168.7.4' }],
        verifiedAddressChanges: [], ipReuse: [], serviceChanges: [], scopeChanges: [], macChanges: [], gatewayChanges: [],
        identityChanges: [], topologyChanges: { added: [], removed: [] } },
    } });

    expect(panel.text()).toContain('192.168.7.10');
    expect(panel.text()).toContain('RPC verified: shellyplus1-123456789abc');
    expect(panel.text()).toContain('80');
    expect(panel.text()).toContain('No remote collector');
    expect(panel.text()).toContain('not detected');
    expect(panel.text()).not.toContain('offline endpoint');
    panel.unmount();
  });
});
