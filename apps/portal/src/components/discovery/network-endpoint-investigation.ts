export type NetworkEndpointSafeCheck =
  | 'review_dhcp_lease'
  | 'inspect_http_headers'
  | 'verify_read_only_identity'
  | 'compare_future_snapshot'
  | 'manual_identification';

export interface NetworkEndpointInvestigationResult {
  schemaVersion: 1;
  scanId: string;
  endpointId: string;
  createdAt: string;
  provider: string;
  model: string;
  summary: string;
  identification: {
    deviceType: string | null;
    manufacturer: string | null;
    confidence: number | null;
    supportingEvidenceIds: string[];
    uncertainty: string;
  };
  findings: Array<{
    kind: 'observed_fact' | 'manufacturer_clue' | 'hypothesis';
    claim: string;
    confidence: number;
    supportingEvidenceIds: string[];
    missingEvidence: string[];
  }>;
  missingEvidence: string[];
  safeFollowUpChecks: Array<{ action: NetworkEndpointSafeCheck; requiresHumanApproval: true }>;
  evidence: Array<{
    id: string;
    source: string;
    attribute: string;
    value: string | number | boolean;
    observedAt: string;
    confidence: 'observed' | 'reported' | 'inferred';
    provenance?: { database: string; version: string; sourceSha256: string; assignmentType: string; classification: string; prefix: string };
  }>;
}

export type NetworkEndpointInvestigationState = {
  loading: boolean;
  error?: string;
  result?: NetworkEndpointInvestigationResult;
};

export type NetworkEndpointHttpProbeResult =
  | { outcome: 'completed'; reasonCode: string; ipAddress: string; method: 'HEAD'; path: '/'; redirects: 'not_followed'; statusCode: number; server?: string; contentType?: string; observedAt: string }
  | { outcome: 'rejected'; reasonCode: string }
  | { outcome: 'failed'; reasonCode: string };

export type NetworkEndpointHttpProbeState = { loading: boolean; result?: NetworkEndpointHttpProbeResult; error?: string };

export function networkEndpointInvestigationKey(
  scanId: string,
  scopeId: string,
  ipAddress: string,
  endpointId: string,
): string {
  return JSON.stringify([scanId, scopeId, ipAddress, endpointId]);
}

export function cloudEvidenceConsentMessage(provider: string | null): string {
  const destination = provider === 'openai' ? 'OpenAI' : provider || 'the configured cloud AI provider';
  return `This investigation sends local network metadata from the selected saved snapshot to ${destination}: IP address, hostname, observed or device-reported MAC, service details, device/protocol identifiers, timestamps, network scope, and observer host/interface. Captured payloads and credentials are excluded. Continue?`;
}

export const networkEndpointSafeCheckLabels: Record<NetworkEndpointSafeCheck, string> = {
  review_dhcp_lease: 'Review the router DHCP lease',
  inspect_http_headers: 'Review HTTP response headers',
  verify_read_only_identity: 'Run an operator-approved, read-only identity check',
  compare_future_snapshot: 'Compare a later network snapshot',
  manual_identification: 'Ask an operator to identify the device',
};
