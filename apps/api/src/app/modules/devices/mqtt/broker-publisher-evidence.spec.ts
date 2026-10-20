import {
  payloadSha256,
  signBrokerPublisherEvidence,
  verifyBrokerPublisherEvidence,
  type BrokerPublisherEvidenceV1,
} from './broker-publisher-evidence';
import { isPlausibleShellyLanCandidate } from './mqtt-broker-attribution.service';

const key = 'test-only-key-which-is-at-least-32-bytes-long';
const brokerId = 'house-broker-pi';

function event(overrides: Partial<Omit<BrokerPublisherEvidenceV1, 'signature'>> = {}, now = Date.now()) {
  const unsigned = {
    version: 1 as const,
    eventId: '72ab11cd-105e-4c22-a9bc-c59c09f809a1',
    brokerId,
    kind: 'publish' as const,
    clientId: 'shelly-plus1-living-room',
    peerIp: '192.168.1.44',
    topic: 'shellyplus1-78ee4ccf4b54/events/rpc',
    payloadSha256: 'a'.repeat(64),
    observedAt: new Date(now).toISOString(),
    ...overrides,
  };
  return { ...unsigned, signature: signBrokerPublisherEvidence(unsigned, key) };
}

describe('broker publisher evidence v1', () => {
  it('authenticates broker connection metadata without equating client ID to Shelly protocol ID', () => {
    const value = event();
    expect(value.clientId).not.toBe('shellyplus1-78ee4ccf4b54');
    expect(verifyBrokerPublisherEvidence(value, key, brokerId)).toMatchObject({
      kind: 'publish',
      clientId: 'shelly-plus1-living-room',
      peerIp: '192.168.1.44',
      topic: 'shellyplus1-78ee4ccf4b54/events/rpc',
    });
  });

  it('rejects forged, wrong-broker, stale and future-dated evidence', () => {
    const now = Date.now();
    const valid = event({}, now);
    expect(verifyBrokerPublisherEvidence({ ...valid, peerIp: '192.168.1.99' }, key, brokerId, now)).toBeNull();
    expect(verifyBrokerPublisherEvidence(valid, key, 'other-broker', now)).toBeNull();
    expect(verifyBrokerPublisherEvidence(event({ observedAt: new Date(now - 31_000).toISOString() }, now), key, brokerId, now)).toBeNull();
    expect(verifyBrokerPublisherEvidence(event({ observedAt: new Date(now + 6_000).toISOString() }, now), key, brokerId, now)).toBeNull();
  });

  it('validates disconnect events without topic or payload fingerprints', () => {
    const value = event({
      kind: 'disconnect', topic: null, payloadSha256: null,
      eventId: '72ab11cd-105e-4c22-a9bc-c59c09f809a2',
    });
    expect(verifyBrokerPublisherEvidence(value, key, brokerId)?.kind).toBe('disconnect');
    expect(verifyBrokerPublisherEvidence({ ...value, topic: 'bad/topic' }, key, brokerId)).toBeNull();
  });

  it('hashes payload bytes and accepts only scoped private LAN candidates, never NAT or gateway addresses', () => {
    expect(payloadSha256('payload')).toBe('239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5');
    const original = process.env.HOME_NETWORK_ZONES_JSON;
    process.env.HOME_NETWORK_ZONES_JSON = JSON.stringify({ zones: [
      { id: 'upstream-lan', name: 'HouseNet', cidr: '192.168.1.0/24', seedIps: [], gatewayIps: ['192.168.1.1', '192.168.1.254'] },
      { id: 'eero-lan', name: 'Eero LAN', cidr: '192.168.7.0/24', seedIps: [], gatewayIps: ['192.168.7.1'] },
    ] });
    try {
      expect(isPlausibleShellyLanCandidate('192.168.1.44')).toBe(true);
      expect(isPlausibleShellyLanCandidate('192.168.1.1')).toBe(false);
      expect(isPlausibleShellyLanCandidate('192.168.1.254')).toBe(false);
      expect(isPlausibleShellyLanCandidate('192.168.7.44')).toBe(true);
      expect(isPlausibleShellyLanCandidate('192.168.7.1')).toBe(false);
      expect(isPlausibleShellyLanCandidate('89.106.117.205')).toBe(false);
      expect(isPlausibleShellyLanCandidate('172.32.0.4')).toBe(false);
    } finally {
      if (original === undefined) delete process.env.HOME_NETWORK_ZONES_JSON;
      else process.env.HOME_NETWORK_ZONES_JSON = original;
    }
  });

  it('fails closed when a network zone has no configured gateway inventory', () => {
    const original = process.env.HOME_NETWORK_ZONES_JSON;
    process.env.HOME_NETWORK_ZONES_JSON = JSON.stringify({ zones: [
      { id: 'house', name: 'HouseNet', cidr: '192.168.1.0/24' },
    ] });
    try {
      expect(isPlausibleShellyLanCandidate('192.168.1.44')).toBe(false);
    } finally {
      if (original === undefined) delete process.env.HOME_NETWORK_ZONES_JSON;
      else process.env.HOME_NETWORK_ZONES_JSON = original;
    }
  });
});
