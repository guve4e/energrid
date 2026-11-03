import { selectAuthorizedSiteLocalObserver, validateSiteLocalShellyEvidence, type SiteLocalShellyEvidenceInput } from './site-local-shelly-evidence-intake';

const now = Date.parse('2026-10-27T06:40:00.000Z');
const timestamp = '2026-10-27T06:39:00.000Z';
const owner = { tenantId: 'tenant-demo', siteId: 'site-home' };
const zone = { id: 'home-lan', name: 'HouseNet', cidr: '192.168.1.0/24', seedIps: [], collectionSource: 'local' as const };
const physicalId = 'shellypro2pm-ec6260888084';
const observer = { id: 'pi-house-net', host: 'energrid-pi', tenantId: 'tenant-demo', siteId: 'site-home', scopeId: zone.id, cidr: zone.cidr, expectedDeviceIds: [physicalId] };

function report(overrides: Partial<SiteLocalShellyEvidenceInput> = {}): SiteLocalShellyEvidenceInput {
  return {
    reportId: 'report-20261027-0639-a', observerId: observer.id, scopeId: zone.id, scopeCidr: zone.cidr,
    startedAt: timestamp, completedAt: timestamp,
    observer: { host: observer.host, observedAt: timestamp, interfaceName: 'eth0', address: '192.168.1.6', cidr: zone.cidr, routeCidr: zone.cidr },
    scan: { status: 'targeted_complete', mode: 'single_target_read_only', targetCount: 1, hostDiscoveryComplete: false, serviceEnrichmentComplete: true,
      endpoints: [{ ipAddress: '192.168.1.166', observedAt: timestamp }] },
    endpoint: { ipAddress: '192.168.1.166', observedMacAddress: 'ec:62:60:88:80:84' },
    identity: { method: 'GET /rpc/Shelly.GetDeviceInfo', observedAt: timestamp,
      response: { id: physicalId, mac: 'EC:62:60:88:80:84', model: 'SPSW-202PE16EU', app: 'Pro2PM', gen: 2, ver: '2.0.0' } },
    components: [{ key: 'switch:0', method: 'Switch.GetStatus?id=0', observedAt: timestamp,
      response: { id: 0, output: false, apower: 1150, aenergy: { total: 600 }, voltage: 234.8, current: 4.9 } },
      { key: 'switch:1', method: 'Switch.GetStatus?id=1', observedAt: timestamp,
        response: { id: 1, output: true, apower: 320, aenergy: { total: 120 }, voltage: 234.8, current: 1.4 } }],
    ...overrides,
  };
}

function validate(input: unknown) {
  return validateSiteLocalShellyEvidence(input, { ownership: owner, zones: [zone], observers: [observer], now });
}

describe('site-local Shelly evidence intake', () => {
  describe('site-local observer selection', () => {
    const secondIdentity = 'shellyplus1-8813bfcdc8bc';
    const secondObserver = { ...observer, id: 'pi-upstream-bathroom', host: 'pi', expectedDeviceIds: [secondIdentity],
      expectedComponentKeys: ['switch:0'] };

    it('selects the uniquely authorized identity and component when a scope has multiple observers', () => {
      expect(selectAuthorizedSiteLocalObserver({ observers: [observer, secondObserver], tenantId: owner.tenantId,
        siteId: owner.siteId, scopeId: zone.id, physicalId: secondIdentity, component: 'switch:0' }))
        .toEqual({ observer: secondObserver, reason: 'selected' });
    });

    it('fails closed for a wrong site, device, component, or duplicate assignment', () => {
      const input = { observers: [observer, secondObserver], tenantId: owner.tenantId,
        siteId: owner.siteId, scopeId: zone.id, physicalId: secondIdentity, component: 'switch:0' };
      expect(selectAuthorizedSiteLocalObserver({ ...input, siteId: 'other-site' })).toMatchObject({ observer: null, reason: 'observer_identity_not_authorized' });
      expect(selectAuthorizedSiteLocalObserver({ ...input, physicalId: 'shellyplus1-000000000000' })).toMatchObject({ observer: null, reason: 'observer_identity_not_authorized' });
      expect(selectAuthorizedSiteLocalObserver({ ...input, component: 'switch:1' })).toMatchObject({ observer: null, reason: 'observer_component_not_authorized' });
      expect(selectAuthorizedSiteLocalObserver({ ...input, observers: [observer, secondObserver, { ...secondObserver, id: 'duplicate-assignment' }] }))
        .toMatchObject({ observer: null, reason: 'observer_assignment_ambiguous' });
    });
  });

  it('projects fresh observer-owned RPC evidence into the existing network endpoint contract', () => {
    const result = validate(report());
    expect(result.device).toMatchObject({ id: physicalId, ipAddress: '192.168.1.166', vendor: 'Shelly',
      networkZoneId: zone.id, deviceReportedMacAddress: 'ec:62:60:88:80:84', components: [
        { component: 'switch:0', channel: 0 }, { component: 'switch:1', channel: 1 },
      ] });
    expect(result.device.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'site_local_http_rpc', attribute: 'shelly.component_status', value: 'switch:0', method: 'Switch.GetStatus?id=0' }),
      expect.objectContaining({ source: 'site_local_http_rpc', attribute: 'shelly.measurement_capability', value: 'switch:0:power' }),
      expect.objectContaining({ source: 'site_local_http_rpc', attribute: 'shelly.measurement_capability', value: 'switch:0:energy_import_total' }),
    ]));
    expect(result.scanId).toBe(validate(report({ reportId: 'different-report-id' })).scanId);
  });

  it('supports real switch status evidence and does not infer another switch channel', () => {
    const result = validate(report({ components: [{ key: 'switch:1', method: 'Switch.GetStatus?id=1', observedAt: timestamp, response: { id: 1, output: false } }] }));
    expect(result.device.components).toEqual([{ component: 'switch:1', channel: 1 }]);
  });

  it('does not claim a neighbor MAC when only protocol-reported MAC evidence was provided', () => {
    const result = validate(report({ endpoint: { ipAddress: '192.168.1.166' }, components: [
      { key: 'switch:0', method: 'Switch.GetStatus?id=0', observedAt: timestamp,
        response: { id: 0, output: false, apower: 1150, aenergy: { total: 600 } } },
    ] }));
    expect(result.device.components).toEqual([{ component: 'switch:0', channel: 0 }]);
    expect(result.device.macAddress).toBeUndefined();
    expect(result.device.deviceReportedMacAddress).toBe('ec:62:60:88:80:84');
  });

  it.each([
    ['wrong site', { ownership: { tenantId: owner.tenantId, siteId: 'site-device-lab' } }],
    ['wrong scope', { zones: [{ ...zone, cidr: '192.168.7.0/24' }] }],
  ])('rejects %s authorization', (_label, options) => {
    expect(() => validateSiteLocalShellyEvidence(report(), { ownership: owner, zones: [zone], observers: [observer], now, ...options } as any))
      .toThrow(/authorized|configured/);
  });

  it('rejects identity/MAC mismatch, stale evidence, incomplete host discovery and unsupported components', () => {
    expect(() => validate(report({ identity: { ...report().identity, response: { ...report().identity.response, id: 'shellyplus1-000000000001' } } })))
      .toThrow(/physical identity allowlist/);
    expect(() => validate(report({ endpoint: { ...report().endpoint, observedMacAddress: '00:11:22:33:44:55' } })))
      .toThrow(/MAC conflicts/);
    const stale = '2026-10-27T06:00:00.000Z';
    expect(() => validate(report({ completedAt: stale, startedAt: stale }))).toThrow(/stale/);
    expect(() => validate(report({ scan: { ...report().scan, mode: 'subnet_scan', targetCount: 254 } }))).toThrow(/single-target/);
    expect(() => validate(report({ components: [{ key: 'unknown:0', method: 'Unknown.GetStatus?id=0', observedAt: timestamp, response: { id: 0, state: false } }] }))).toThrow(/Unsupported or mismatched/);
  });
});
