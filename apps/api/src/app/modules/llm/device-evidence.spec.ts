import {
  snapshotId,
  validateAssessment,
  DeviceIntelligenceAssessment,
} from './device-evidence'

import {
  buildNetworkEvidenceSnapshot,
} from './device-evidence-builder'

describe('Device Evidence Engine', () => {
  const device = {
    id: '192.168.1.92',
    ipAddress: '192.168.1.92',
    hostname: 'exo',
    protocol: 'unknown',
  }

  it('creates evidence with provenance', () => {
    const snapshot = buildNetworkEvidenceSnapshot(device)

    expect(snapshot.deviceId).toBe('192.168.1.92')
    expect(snapshot.evidence.length).toBeGreaterThan(0)

    expect(snapshot.evidence[0]).toEqual(
      expect.objectContaining({
        source: 'network_scan',
        confidence: 'reported',
        observedAt: expect.any(String),
      }),
    )
  })

  it('produces stable evidence identifiers', () => {
    const timestamp = '2026-10-18T08:00:00.000Z'

    const first = buildNetworkEvidenceSnapshot(device, timestamp)
    const second = buildNetworkEvidenceSnapshot(device, timestamp)

    expect(first.evidence).toEqual(second.evidence)
    expect(snapshotId(first)).toBe(snapshotId(second))
  })

  it('binds evidence IDs and timestamps to the server-selected network scope', () => {
    const timestamp = '2026-10-20T09:00:00.000Z'
    const first = buildNetworkEvidenceSnapshot({
      ...device,
      observedAt: timestamp,
      scope: { tenantId: 'tenant-a', siteId: 'site-a', networkId: 'upstream' },
      observations: [{ source: 'tcp', attribute: 'port.80.open', value: true, observedAt: timestamp }],
    }, timestamp)
    const second = buildNetworkEvidenceSnapshot({
      ...device,
      observedAt: timestamp,
      scope: { tenantId: 'tenant-a', siteId: 'site-a', networkId: 'guest' },
      observations: [{ source: 'tcp', attribute: 'port.80.open', value: true, observedAt: timestamp }],
    }, timestamp)

    expect(first.scope?.networkId).toBe('upstream')
    expect(first.evidence.find(item => item.attribute === 'port.80.open')).toMatchObject({
      confidence: 'observed', scope: first.scope, observedAt: timestamp,
    })
    expect(first.evidence.map(item => item.id)).not.toEqual(second.evidence.map(item => item.id))
  })

  it('does not include arbitrary metadata or secrets', () => {
    const snapshot = buildNetworkEvidenceSnapshot({
      ...device,
      password: 'secret-value',
      apiKey: 'private-key',
    } as typeof device)

    const serialized = JSON.stringify(snapshot)

    expect(serialized).not.toContain('secret-value')
    expect(serialized).not.toContain('private-key')
  })

  it('rejects hypotheses referencing nonexistent evidence', () => {
    const snapshot = buildNetworkEvidenceSnapshot(device)

    const assessment: DeviceIntelligenceAssessment = {
      schemaVersion: 1,
      deviceId: snapshot.deviceId,
      snapshotId: snapshotId(snapshot),
      hypotheses: [
        {
          id: 'hyp_1',
          claim: 'This is a Raspberry Pi',
          confidence: 0.8,
          supportingEvidenceIds: ['invented-evidence'],
          contradictingEvidenceIds: [],
          missingEvidence: [],
        },
      ],
      proposals: [],
    }

    expect(() =>
      validateAssessment(assessment, snapshot),
    ).toThrow('Unknown evidence reference')
  })

  it('rejects preapproved investigation proposals', () => {
    const snapshot = buildNetworkEvidenceSnapshot(device)

    const assessment: DeviceIntelligenceAssessment = {
      schemaVersion: 1,
      deviceId: snapshot.deviceId,
      snapshotId: snapshotId(snapshot),
      hypotheses: [],
      proposals: [
        {
          id: 'proposal_1',
          action: 'inspect_service_banner',
          reason: 'Identify the SSH service',
          requiredEvidenceIds: [],
          requiresApproval: false,
          status: 'proposed',
        } as DeviceIntelligenceAssessment['proposals'][number],
      ],
    }

    expect(() =>
      validateAssessment(assessment, snapshot),
    ).toThrow('cannot be preapproved')
  })
})

describe('Network scanner observation preservation', () => {
  it('preserves an observed open TCP port', () => {
    const snapshot = buildNetworkEvidenceSnapshot({
      id: '192.168.1.92',
      ipAddress: '192.168.1.92',
      observations: [
        {
          source: 'tcp',
          attribute: 'port.22.open',
          value: true,
        },
      ],
    })

    expect(snapshot.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'network_scan',
          attribute: 'port.22.open',
          value: true,
        }),
      ]),
    )
  })

  it('rejects unsupported observation attributes', () => {
    const snapshot = buildNetworkEvidenceSnapshot({
      id: '192.168.1.92',
      observations: [
        {
          source: 'tcp',
          attribute: 'password',
          value: 'DO_NOT_SEND',
        },
      ],
    })

    expect(JSON.stringify(snapshot)).not.toContain('DO_NOT_SEND')
  })
})
