import { createHash } from 'node:crypto'

export type EvidenceSource =
  | 'network_scan'
  | 'mdns'
  | 'ssdp'
  | 'http'
  | 'mqtt'
  | 'registry'
  | 'manual'
  | 'device_telemetry'

export type EvidenceConfidence = 'observed' | 'reported' | 'inferred'

export interface DeviceEvidence {
  id: string
  source: EvidenceSource
  attribute: string
  value: string | number | boolean
  observedAt: string
  confidence: EvidenceConfidence
  scope?: { tenantId: string; siteId: string; networkId: string }
  verification?: 'scan_observed' | 'device_reported' | 'inferred'
}

export interface DeviceEvidenceSnapshot {
  schemaVersion: 1
  deviceId: string
  createdAt: string
  evidence: DeviceEvidence[]
  scope?: { tenantId: string; siteId: string; networkId: string }
}

export interface DeviceHypothesis {
  id: string
  claim: string
  confidence: number
  supportingEvidenceIds: string[]
  contradictingEvidenceIds: string[]
  missingEvidence: string[]
}

export type InvestigationAction =
  | 'inspect_mdns'
  | 'inspect_ssdp'
  | 'inspect_http_headers'
  | 'inspect_service_banner'
  | 'review_registry'
  | 'manual_identification'

export interface InvestigationProposal {
  id: string
  action: InvestigationAction
  reason: string
  requiredEvidenceIds: string[]
  requiresApproval: true
  status: 'proposed'
}

export interface DeviceIntelligenceAssessment {
  schemaVersion: 1
  deviceId: string
  snapshotId: string
  hypotheses: DeviceHypothesis[]
  proposals: InvestigationProposal[]
}

export function evidenceId(
  deviceId: string,
  source: EvidenceSource,
  attribute: string,
  value: string | number | boolean,
  scope?: { tenantId: string; siteId: string; networkId: string },
): string {
  const canonical = JSON.stringify([
    deviceId,
    scope?.tenantId || '',
    scope?.siteId || '',
    scope?.networkId || '',
    source,
    attribute,
    value,
  ])

  return `ev_${createHash('sha256')
    .update(canonical)
    .digest('hex')
    .slice(0, 20)}`
}

export function snapshotId(
  snapshot: DeviceEvidenceSnapshot,
): string {
  const canonical = JSON.stringify([
    snapshot.schemaVersion,
    snapshot.deviceId,
    snapshot.scope || null,
    snapshot.evidence.map((item) => [
      item.id,
      item.observedAt,
    ]),
  ])

  return `snap_${createHash('sha256')
    .update(canonical)
    .digest('hex')
    .slice(0, 20)}`
}


const investigationActions = new Set<InvestigationAction>([
  'inspect_mdns',
  'inspect_ssdp',
  'inspect_http_headers',
  'inspect_service_banner',
  'review_registry',
  'manual_identification',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length <= 20 &&
    value.every((item) =>
      typeof item === 'string' && item.length <= 500
    )
}

export function validateAssessment(
  assessment: unknown,
  snapshot: DeviceEvidenceSnapshot,
): asserts assessment is DeviceIntelligenceAssessment {
  if (!isRecord(assessment)) {
    throw new Error('Invalid assessment object')
  }

  if (
    assessment.schemaVersion !== 1 ||
    assessment.deviceId !== snapshot.deviceId ||
    assessment.snapshotId !== snapshotId(snapshot)
  ) {
    throw new Error('Assessment does not match evidence snapshot')
  }

  if (
    !Array.isArray(assessment.hypotheses) ||
    assessment.hypotheses.length > 12 ||
    !Array.isArray(assessment.proposals) ||
    assessment.proposals.length > 12
  ) {
    throw new Error('Invalid assessment collections')
  }

  const evidenceIds = new Set(
    snapshot.evidence.map((item) => item.id),
  )

  function validateReferences(ids: unknown): void {
    if (!isStringArray(ids)) {
      throw new Error('Invalid evidence references')
    }

    for (const id of ids) {
      if (!evidenceIds.has(id)) {
        throw new Error(`Unknown evidence reference: ${id}`)
      }
    }
  }

  const hypothesisIds = new Set<string>()

  for (const hypothesis of assessment.hypotheses) {
    if (
      !isRecord(hypothesis) ||
      typeof hypothesis.id !== 'string' ||
      !hypothesis.id ||
      hypothesis.id.length > 100 ||
      hypothesisIds.has(hypothesis.id) ||
      typeof hypothesis.claim !== 'string' ||
      !hypothesis.claim ||
      hypothesis.claim.length > 1000 ||
      typeof hypothesis.confidence !== 'number' ||
      !Number.isFinite(hypothesis.confidence) ||
      hypothesis.confidence < 0 ||
      hypothesis.confidence > 1 ||
      !isStringArray(hypothesis.missingEvidence)
    ) {
      throw new Error('Invalid hypothesis')
    }

    hypothesisIds.add(hypothesis.id)

    validateReferences(hypothesis.supportingEvidenceIds)
    validateReferences(hypothesis.contradictingEvidenceIds)
  }

  const proposalIds = new Set<string>()

  for (const proposal of assessment.proposals) {
    if (!isRecord(proposal)) {
      throw new Error('Invalid investigation proposal')
    }

    if (
      typeof proposal.id !== 'string' ||
      !proposal.id ||
      proposal.id.length > 100 ||
      proposalIds.has(proposal.id) ||
      typeof proposal.reason !== 'string' ||
      !proposal.reason ||
      proposal.reason.length > 1000
    ) {
      throw new Error('Invalid investigation proposal')
    }

    proposalIds.add(proposal.id)

    if (
      typeof proposal.action !== 'string' ||
      !investigationActions.has(
        proposal.action as InvestigationAction,
      )
    ) {
      throw new Error('Unsupported investigation action')
    }

    if (
      proposal.requiresApproval !== true ||
      proposal.status !== 'proposed'
    ) {
      throw new Error('Investigation proposal cannot be preapproved')
    }

    validateReferences(proposal.requiredEvidenceIds)
  }
}
