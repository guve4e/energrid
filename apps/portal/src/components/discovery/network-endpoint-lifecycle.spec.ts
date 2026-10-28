import { describe, expect, it } from 'vitest';
import { resolveNetworkEndpointLifecycle, resolveNetworkSnapshotLifecycles } from './network-endpoint-lifecycle';

const endpoint = {
  id: 'shellyplus1-123456789abc',
  networkZoneId: 'eero',
  ipAddress: '192.168.7.10',
  observations: [{ source: 'http_rpc', attribute: 'shelly.device_id', value: 'shellyplus1-123456789abc' }],
};
const espEndpoint = (id: string) => ({
  id,
  networkZoneId: 'upstream-lan',
  ipAddress: '192.168.1.198',
  observations: [
    { source: 'http_identity', attribute: 'identity.verified', value: true },
    { source: 'http_identity', attribute: 'identity.device_id', value: id },
  ],
});

describe('network endpoint lifecycle projection', () => {
  it('links a verified protocol identity to an existing pending record', () => {
    const result = resolveNetworkEndpointLifecycle(endpoint, [{
      key: 'pending:physical-1',
      details: [{ candidateId: 'candidate-1', physicalHardwareId: endpoint.id, verificationStatus: 'protocol_observed' }],
    }], [], []);

    expect(result).toMatchObject({ stage: 'pending', recordId: 'pending:physical-1' });
  });

  it('does not correlate a pending candidate by matching IP alone', () => {
    const result = resolveNetworkEndpointLifecycle(endpoint, [{
      key: 'pending:other-device',
      details: [{ candidateId: 'candidate-1', physicalHardwareId: 'shellyplus1-aaaaaaaaaaaa', verificationStatus: 'protocol_observed' }],
    }], [], []);

    expect(result.stage).toBe('identified');
    expect(result.recordId).toBeUndefined();
  });

  it('requires a verified endpoint identity before linking an enrolled record', () => {
    const result = resolveNetworkEndpointLifecycle({ ...endpoint, observations: [] }, [], [{
      id: 'logical-1', displayName: 'Kitchen switch', tenantId: 'tenant', siteId: 'site', metadata: { physicalId: endpoint.id },
    }], []);

    expect(result.stage).toBe('observed');
    expect(result.recordId).toBeUndefined();
  });

  it('links an enrolled device by exact protocol identity, never by endpoint address', () => {
    const result = resolveNetworkEndpointLifecycle(endpoint, [], [{
      id: 'logical-1', displayName: 'Kitchen switch', tenantId: 'tenant', siteId: 'site', metadata: { physicalId: endpoint.id },
    }], []);

    expect(result).toMatchObject({ stage: 'enrolled', recordId: 'logical-1' });
  });

  it('correlates the real ESP8266 324864 through its durable physical assignment', () => {
    const result = resolveNetworkEndpointLifecycle(espEndpoint('esp8266:324864'), [], [{
      id: 'device:upstream-lan:esp8266:324864',
      displayName: 'Garage ESP8266',
      tenantId: 'tenant-demo',
      siteId: 'site-home',
      identityValues: ['esp8266:324864'],
    }], []);

    expect(result).toMatchObject({ stage: 'enrolled', recordId: 'device:upstream-lan:esp8266:324864' });
  });

  it('resolves Garage lifecycle for a saved scan even when the device is absent from the latest scan', () => {
    const saved = espEndpoint('esp8266:324864');
    const result = resolveNetworkSnapshotLifecycles([
      { scanId: 'latest', ownership: { tenantId: 'tenant-demo', siteId: 'site-home' }, endpoints: [] },
      { scanId: 'saved-garage-scan', ownership: { tenantId: 'tenant-demo', siteId: 'site-home' }, endpoints: [saved] },
    ], [], [{
      id: 'device:upstream-lan:esp8266:324864', displayName: 'Garage ESP8266',
      tenantId: 'tenant-demo', siteId: 'site-home', identityValues: ['esp8266:324864'],
    }], []);

    expect(result).toContainEqual(expect.objectContaining({
      snapshotId: 'saved-garage-scan',
      endpointKey: 'upstream-lan:192.168.1.198:esp8266:324864',
      stage: 'enrolled',
      recordId: 'device:upstream-lan:esp8266:324864',
    }));
  });

  it('does not correlate legacy unscoped snapshot identities to the active site lifecycle', () => {
    const result = resolveNetworkSnapshotLifecycles([
      { scanId: 'legacy', endpoints: [espEndpoint('esp8266:a1b2c3')] },
    ], [{ key: 'pending:lab-device', details: [{
      candidateId: 'candidate-lab', physicalHardwareId: 'esp8266:a1b2c3', verificationStatus: 'protocol_observed',
    }] }], [], []);

    expect(result).toEqual([{
      endpointKey: 'upstream-lan:192.168.1.198:esp8266:a1b2c3', snapshotId: 'legacy', stage: 'observed',
    }]);
  });

  it('does not correlate a scoped snapshot to a same-identity pending record from another site', () => {
    const result = resolveNetworkSnapshotLifecycles([
      { scanId: 'home', ownership: { tenantId: 'tenant-demo', siteId: 'site-home' }, endpoints: [espEndpoint('esp8266:a1b2c3')] },
    ], [{
      tenantId: 'tenant-demo', siteId: 'site-virtual-lab', key: 'pending:lab-device', details: [{
        candidateId: 'candidate-lab', physicalHardwareId: 'esp8266:a1b2c3', verificationStatus: 'protocol_observed',
      }],
    }], [], []);

    expect(result[0]).toMatchObject({ stage: 'identified', snapshotId: 'home' });
    expect(result[0].recordId).toBeUndefined();
  });

  it('correlates another enrolled ESP8266 by its own exact identity', () => {
    const result = resolveNetworkEndpointLifecycle(espEndpoint('esp8266:3254b7'), [], [{
      id: 'device:upstream-lan:esp8266:3254b7',
      displayName: 'Hall ESP8266', tenantId: 'tenant-demo', siteId: 'site-home',
      identityValues: ['esp8266:3254b7'],
    }], []);

    expect(result).toMatchObject({ stage: 'enrolled', recordId: 'device:upstream-lan:esp8266:3254b7' });
  });

  it('keeps a verified but genuinely unenrolled sensor identified', () => {
    const result = resolveNetworkEndpointLifecycle(espEndpoint('esp8266:abcdef'), [], [], []);

    expect(result.stage).toBe('identified');
    expect(result.recordId).toBeUndefined();
  });

  it('does not use suffix matching to correlate verified identities', () => {
    const result = resolveNetworkEndpointLifecycle(espEndpoint('esp8266:324864'), [], [{
      id: 'logical-1', displayName: 'Different device', tenantId: 'tenant-demo', siteId: 'site-home',
      identityValues: ['prefix-esp8266:324864'],
    }], []);

    expect(result.stage).toBe('identified');
  });

  it('marks duplicate physical identity assignments ambiguous instead of selecting a logical record', () => {
    const result = resolveNetworkEndpointLifecycle(espEndpoint('esp8266:324864'), [], [
      { id: 'logical-a', displayName: 'Garage A', tenantId: 'tenant-demo', siteId: 'site-home', identityValues: ['esp8266:324864'] },
      { id: 'logical-b', displayName: 'Garage B', tenantId: 'tenant-demo', siteId: 'site-home', identityValues: ['ESP8266:324864'] },
    ], []);

    expect(result).toMatchObject({ stage: 'ambiguous', relatedRecords: 2 });
    expect(result.recordId).toBeUndefined();
  });

  it('treats distinct components assigned to one physical inventory record as one enrolled device', () => {
    const physicalId = '8e15ec60-a22b-4f8c-ab09-5e61d44030f9';
    const result = resolveNetworkEndpointLifecycle(endpoint, [], [
      { id: 'shellyplus1-123456789abc:switch:0', displayName: 'Washer/Fan', tenantId: 'tenant', siteId: 'site',
        identityValues: [endpoint.id], physicalAssignments: [{ physicalDeviceId: physicalId, componentKey: 'switch:0' }] },
      { id: 'shellyplus1-123456789abc:switch:1', displayName: 'Refrigerator', tenantId: 'tenant', siteId: 'site',
        identityValues: [endpoint.id], physicalAssignments: [{ physicalDeviceId: physicalId, componentKey: 'switch:1' }] },
    ], []);

    expect(result).toMatchObject({ stage: 'enrolled', recordId: 'shellyplus1-123456789abc:switch:0', relatedRecords: 2 });
  });

  it('keeps multiple physical inventory records ambiguous even when their logical components differ', () => {
    const result = resolveNetworkEndpointLifecycle(endpoint, [], [
      { id: 'shellyplus1-123456789abc:switch:0', displayName: 'Output 0', tenantId: 'tenant', siteId: 'site',
        identityValues: [endpoint.id], physicalAssignments: [{ physicalDeviceId: 'physical-a', componentKey: 'switch:0' }] },
      { id: 'shellyplus1-123456789abc:switch:1', displayName: 'Output 1', tenantId: 'tenant', siteId: 'site',
        identityValues: [endpoint.id], physicalAssignments: [{ physicalDeviceId: 'physical-b', componentKey: 'switch:1' }] },
    ], []);

    expect(result).toMatchObject({ stage: 'ambiguous', relatedRecords: 2 });
    expect(result.recordId).toBeUndefined();
  });

  it('keeps duplicate assignments without explicit distinct component keys ambiguous', () => {
    const result = resolveNetworkEndpointLifecycle(endpoint, [], [
      { id: 'logical-a', displayName: 'Output A', tenantId: 'tenant', siteId: 'site', identityValues: [endpoint.id],
        physicalAssignments: [{ physicalDeviceId: 'physical-one' }] },
      { id: 'logical-b', displayName: 'Output B', tenantId: 'tenant', siteId: 'site', identityValues: [endpoint.id],
        physicalAssignments: [{ physicalDeviceId: 'physical-one' }] },
    ], []);

    expect(result.stage).toBe('ambiguous');
  });

  it('marks a duplicate physical identity claim ambiguous even with one enrollment', () => {
    const result = resolveNetworkEndpointLifecycle(espEndpoint('esp8266:324864'), [], [{
      id: 'logical-1', displayName: 'Garage', tenantId: 'tenant-demo', siteId: 'site-home',
      identityValues: ['esp8266:324864'], ambiguousIdentityValues: ['esp8266:324864'],
    }], []);

    expect(result).toMatchObject({ stage: 'ambiguous' });
  });

  it('requires the verified protocol identity value to agree with its own verified observation', () => {
    const result = resolveNetworkEndpointLifecycle({
      ...espEndpoint('esp8266:324864'),
      observations: [{ source: 'http_identity', attribute: 'identity.verified', value: true }],
    }, [], [{
      id: 'logical-1', displayName: 'Garage', tenantId: 'tenant-demo', siteId: 'site-home',
      identityValues: ['esp8266:324864'],
    }], []);

    expect(result.stage).toBe('observed');
  });
});
