import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export type BrokerPublisherEventKind = 'publish' | 'disconnect';

export interface BrokerPublisherEvidenceV1 {
  version: 1;
  eventId: string;
  brokerId: string;
  kind: BrokerPublisherEventKind;
  clientId: string;
  peerIp: string;
  topic: string | null;
  payloadSha256: string | null;
  observedAt: string;
  signature: string;
}

const maxAgeMs = 30_000;
const maxFutureSkewMs = 5_000;

export function payloadSha256(payloadText: string): string {
  return createHash('sha256').update(payloadText, 'utf8').digest('hex');
}

export function signBrokerPublisherEvidence(
  event: Omit<BrokerPublisherEvidenceV1, 'signature'>,
  key: string,
): string {
  return createHmac('sha256', key).update(canonicalEvidence(event), 'utf8').digest('hex');
}

export function verifyBrokerPublisherEvidence(
  value: unknown,
  key: string,
  expectedBrokerId: string,
  nowMs = Date.now(),
): BrokerPublisherEvidenceV1 | null {
  if (!isEvidenceShape(value)) return null;
  if (value.brokerId !== expectedBrokerId) return null;
  const observedMs = Date.parse(value.observedAt);
  if (!Number.isFinite(observedMs) || observedMs > nowMs + maxFutureSkewMs ||
    nowMs - observedMs > maxAgeMs) return null;
  const expected = Buffer.from(signBrokerPublisherEvidence(value, key), 'hex');
  const received = Buffer.from(value.signature, 'hex');
  if (expected.length !== 32 || received.length !== 32 || !timingSafeEqual(expected, received)) return null;
  return value;
}

function isEvidenceShape(value: unknown): value is BrokerPublisherEvidenceV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (event.version !== 1 || event.kind !== 'publish' && event.kind !== 'disconnect' ||
    !boundedString(event.eventId, 36) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.eventId) ||
    !boundedString(event.brokerId, 128) || !boundedString(event.clientId, 512) ||
    !boundedString(event.peerIp, 128) || isIP(event.peerIp) === 0 ||
    !boundedString(event.observedAt, 40) || !/^[0-9a-f]{64}$/i.test(String(event.signature || ''))) {
    return false;
  }
  if (event.kind === 'publish') {
    return boundedString(event.topic, 1024) && !/[+#\u0000-\u001f\u007f]/.test(event.topic) &&
      !event.topic.startsWith('energrid/broker-evidence/v1') &&
      typeof event.payloadSha256 === 'string' && /^[0-9a-f]{64}$/i.test(event.payloadSha256);
  }
  return event.topic === null && event.payloadSha256 === null;
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function canonicalEvidence(event: Omit<BrokerPublisherEvidenceV1, 'signature'> | BrokerPublisherEvidenceV1): string {
  return JSON.stringify({
    version: 1,
    eventId: event.eventId,
    brokerId: event.brokerId,
    kind: event.kind,
    clientId: event.clientId,
    peerIp: event.peerIp,
    topic: event.topic,
    payloadSha256: event.payloadSha256,
    observedAt: event.observedAt,
  });
}
