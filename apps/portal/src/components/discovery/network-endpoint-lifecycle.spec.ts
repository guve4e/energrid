import { describe, expect, it } from 'vitest';
import { resolveNetworkEndpointLifecycle } from './network-endpoint-lifecycle';

const endpoint = {
  id: 'shellyplus1-123456789abc',
  networkZoneId: 'eero',
  ipAddress: '192.168.7.10',
  observations: [{ source: 'http_rpc', attribute: 'shelly.device_id', value: 'shellyplus1-123456789abc' }],
};

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
});
