import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';
import type { NetworkDiscoverySnapshot } from '../devices/network-discovery-snapshot';
import { NetworkEndpointInvestigatorService } from './network-endpoint-investigator.service';
import { LlmGatewayService } from './llm-gateway.service';

describe('NetworkEndpointInvestigatorService', () => {
  const generate = jest.fn();
  const service = new NetworkEndpointInvestigatorService({ generate } as unknown as LlmGatewayService);

  const snapshot: NetworkDiscoverySnapshot = {
    schemaVersion: 2,
    scanId: 'scan-eero-1',
    startedAt: '2026-10-21T10:00:00.000Z',
    completedAt: '2026-10-21T10:01:00.000Z',
    collector: { id: 'mac/en0', host: 'mac.local', interfaces: ['en0'] },
    scopes: [{ id: 'eero', name: 'Eero LAN', cidr: '192.168.7.0/24', complete: true, gatewayIpsObserved: [] }],
    methods: ['neighbor_table', 'nmap_tcp_connect_service_scan'],
    successes: 1,
    failures: [],
    limitations: [],
    rawEvidenceOmitted: 0,
    rawEvidence: [{
      observedAt: '2026-10-21T10:00:40.000Z', source: 'neighbor_table', scopeId: 'eero',
      evidence: { ipAddress: '192.168.7.48', macAddress: 'aa:bb:cc:dd:ee:ff' },
    }],
    topology: { relationships: [] },
    runtime: {
      observedAt: '2026-10-21T10:01:00.000Z',
      observer: { id: 'observer/mac', host: 'mac.local', platform: 'darwin' },
      interfaces: [], routes: [], localScopes: [], configuredScopes: [], capabilities: [], limitations: [],
    },
    endpoints: [{
      id: 'unknown-host', ipAddress: '192.168.7.48', networkZoneId: 'eero', networkZoneName: 'Eero LAN',
      macAddress: 'aa:bb:cc:dd:ee:ff', protocol: 'unknown', confidence: 0.4, status: 'online',
      discoveredAt: '2026-10-21T10:00:40.000Z', reason: 'TCP service observed',
      observations: [
        { source: 'tcp', attribute: 'port.80.open', value: true, observedAt: '2026-10-21T10:00:40.000Z', scopeId: 'eero', interfaceName: 'en0' },
        { source: 'tcp', attribute: 'port.80.service', value: 'http', observedAt: '2026-10-21T10:00:40.000Z', scopeId: 'eero', interfaceName: 'en0' },
        { source: 'http_rpc', attribute: 'token', value: 'secret=should-not-leak', observedAt: '2026-10-21T10:00:40.000Z', scopeId: 'eero' },
      ],
    }],
  };

  const request = { scanId: 'scan-eero-1', scopeId: 'eero', ipAddress: '192.168.7.48', endpointId: 'unknown-host' };
  const answer = (overrides: Record<string, unknown> = {}) => ({
    summary: 'Evidence is insufficient to identify a manufacturer.',
    identification: {
      deviceType: null,
      manufacturer: null,
      confidence: null,
      supportingEvidenceIds: [],
      uncertainty: 'Only an HTTP service is known.',
    },
    findings: [{ kind: 'observed_fact', claim: 'TCP port 80 was observed open.', confidence: 1, supportingEvidenceIds: ['placeholder'], missingEvidence: [] }],
    missingEvidence: ['HTTP response headers'],
    safeFollowUpChecks: [{ action: 'inspect_http_headers', requiresHumanApproval: true }],
    ...overrides,
  });

  beforeEach(() => generate.mockReset());

  it('uses only the selected immutable snapshot endpoint and returns cited, structured findings', async () => {
    generate.mockImplementation(async (input: { userPrompt: string }) => {
      const evidence = JSON.parse(input.userPrompt).evidence as Array<{ id: string; attribute: string }>;
      const portEvidence = evidence.find(item => item.attribute === 'port.80.open')!;
      return {
        provider: 'test-provider', model: 'test-model',
        text: JSON.stringify(answer({ findings: [{
          kind: 'observed_fact', claim: 'TCP port 80 was observed open.', confidence: 1,
          supportingEvidenceIds: [portEvidence.id], missingEvidence: [],
        }] })),
      };
    });

    const result = await service.investigate(snapshot, request);
    const prompt = generate.mock.calls[0][0].userPrompt as string;
    const payload = JSON.parse(prompt);

    expect(result).toMatchObject({ scanId: 'scan-eero-1', endpointId: 'unknown-host', provider: 'test-provider' });
    expect(result.identification.deviceType).toBeNull();
    expect(result.safeFollowUpChecks).toEqual([{ action: 'inspect_http_headers', requiresHumanApproval: true }]);
    expect(payload).toMatchObject({ observer: { host: 'mac.local', platform: 'darwin' }, endpoint: { ipAddress: '192.168.7.48' } });
    expect(payload.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'tcp', attribute: 'port.80.open', observedAt: '2026-10-21T10:00:40.000Z' }),
      expect.objectContaining({ source: 'neighbor_table', attribute: 'observed_mac', value: 'aa:bb:cc:dd:ee:ff' }),
    ]));
    expect(prompt).not.toContain('should-not-leak');
    expect(prompt).not.toContain('secret=');
    expect(generate.mock.calls[0][0].outputSchema).toBeDefined();
  });

  it('rejects an endpoint outside the requested snapshot scope', async () => {
    await expect(service.investigate(snapshot, { ...request, scopeId: 'other' })).rejects.toBeInstanceOf(NotFoundException);
    expect(generate).not.toHaveBeenCalled();
  });

  it('preserves router-feed MAC provenance as reported evidence', async () => {
    generate.mockImplementation(async (input: { userPrompt: string }) => {
      const evidence = JSON.parse(input.userPrompt).evidence as Array<{ id: string; attribute: string; source: string; confidence: string }>;
      const portEvidence = evidence.find(item => item.attribute === 'port.80.open')!;
      return {
        provider: 'test-provider', model: 'test-model',
        text: JSON.stringify(answer({ findings: [{ kind: 'observed_fact', claim: 'HTTP port observed.', confidence: 1, supportingEvidenceIds: [portEvidence.id], missingEvidence: [] }] })),
      };
    });
    const routerSnapshot = structuredClone(snapshot);
    routerSnapshot.rawEvidence[0] = {
      observedAt: '2026-10-21T10:00:20.000Z', source: 'router_clients', scopeId: 'eero',
      evidence: { ipAddress: '192.168.7.48', macAddress: 'aa:bb:cc:dd:ee:ff' },
    };
    await service.investigate(routerSnapshot, request);
    const evidence = JSON.parse(generate.mock.calls[0][0].userPrompt).evidence;
    expect(evidence).toContainEqual(expect.objectContaining({ source: 'router_client_feed', attribute: 'observed_mac', confidence: 'reported' }));
  });

  it('adds a versioned Espressif interface-vendor clue without treating it as device identity', async () => {
    const clueSnapshot = structuredClone(snapshot);
    clueSnapshot.endpoints[0].macAddress = '3c:71:bf:32:4b:44';
    clueSnapshot.rawEvidence[0].evidence.macAddress = '3c:71:bf:32:4b:44';
    generate.mockImplementation(async (input: { userPrompt: string }) => {
      const evidence = JSON.parse(input.userPrompt).evidence as Array<{ id: string; attribute: string; provenance?: object }>;
      const port = evidence.find(item => item.attribute === 'port.80.open')!;
      return { provider: 'test-provider', model: 'test-model', text: JSON.stringify(answer({ findings: [{
        kind: 'observed_fact', claim: 'TCP port 80 was observed open.', confidence: 1, supportingEvidenceIds: [port.id], missingEvidence: [],
      }] })) };
    });

    const result = await service.investigate(clueSnapshot, request);
    const clue = result.evidence.find(item => item.attribute === 'mac_oui.interface_vendor_clue');
    expect(clue).toMatchObject({ source: 'ieee_oui_database', value: 'Espressif Inc.', confidence: 'reported' });
    expect(clue?.provenance).toMatchObject({ assignmentType: 'MA-L', classification: 'network_interface_vendor_clue', prefix: '3C:71:BF', sourceSha256: expect.any(String) });
    expect(JSON.stringify(clue?.provenance)).toContain('ieee-ma-l-snapshot-2026-10-21');
    expect(result.identification.manufacturer).toBeNull();
  });

  it('does not accept a MAC chip-vendor clue as proof of the device manufacturer', async () => {
    const clueSnapshot = structuredClone(snapshot);
    clueSnapshot.endpoints[0].macAddress = '3c:71:bf:32:4b:44';
    clueSnapshot.rawEvidence[0].evidence.macAddress = '3c:71:bf:32:4b:44';
    generate.mockImplementation(async (input: { userPrompt: string }) => {
      const clue = (JSON.parse(input.userPrompt).evidence as Array<{ id: string; attribute: string }>).find(item => item.attribute === 'mac_oui.interface_vendor_clue')!;
      return { provider: 'test-provider', model: 'test-model', text: JSON.stringify(answer({ identification: {
        deviceType: 'smart plug', manufacturer: 'Espressif Inc.', confidence: 0.9,
        supportingEvidenceIds: [clue.id], uncertainty: '',
      } })) };
    });
    await expect(service.investigate(clueSnapshot, request)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('rejects already verified identities so discovery cannot relabel them', async () => {
    const verified = structuredClone(snapshot);
    verified.endpoints[0].observations!.push({ source: 'http_rpc', attribute: 'shelly.device_id', value: 'shellyplus1-abc123', observedAt: verified.completedAt });
    verified.endpoints[0].id = 'shellyplus1-abc123';
    await expect(service.investigate(verified, { ...request, endpointId: 'shellyplus1-abc123' })).rejects.toBeInstanceOf(BadRequestException);
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects malformed LLM output', async () => {
    generate.mockResolvedValue({ provider: 'openai', model: 'test', text: 'not JSON' });
    await expect(service.investigate(snapshot, request)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('rejects unsupported claims without evidence references', async () => {
    generate.mockResolvedValue({ provider: 'openai', model: 'test', text: JSON.stringify(answer({
      identification: { deviceType: 'camera', manufacturer: 'Example', confidence: 0.9, supportingEvidenceIds: [], uncertainty: '' },
    })) });
    await expect(service.investigate(snapshot, request)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('rejects a malformed or unallowlisted follow-up probe proposal', async () => {
    generate.mockResolvedValue({ provider: 'openai', model: 'test', text: JSON.stringify(answer({
      safeFollowUpChecks: [{ action: 'fetch_http://169.254.169.254/latest/meta-data', requiresHumanApproval: true }],
    })) });
    await expect(service.investigate(snapshot, request)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('rejects identity claims supported only by an address or MAC observation', async () => {
    generate.mockImplementation(async (input: { userPrompt: string }) => {
      const evidence = JSON.parse(input.userPrompt).evidence as Array<{ id: string; attribute: string }>;
      const ip = evidence.find(item => item.attribute === 'ip_address')!;
      return {
        provider: 'openai', model: 'test',
        text: JSON.stringify(answer({
          identification: { deviceType: 'camera', manufacturer: 'Example', confidence: 0.9, supportingEvidenceIds: [ip.id], uncertainty: '' },
        })),
      };
    });
    await expect(service.investigate(snapshot, request)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('returns an explicit uncertain result when the provider finds insufficient evidence', async () => {
    generate.mockImplementation(async (input: { userPrompt: string }) => {
      const evidence = JSON.parse(input.userPrompt).evidence as Array<{ id: string; attribute: string }>;
      const portEvidence = evidence.find(item => item.attribute === 'port.80.open')!;
      return {
        provider: 'local', model: 'local-test',
        text: JSON.stringify(answer({ findings: [{ kind: 'observed_fact', claim: 'TCP port 80 was observed open.', confidence: 1, supportingEvidenceIds: [portEvidence.id], missingEvidence: [] }] })),
      };
    });
    const result = await service.investigate(snapshot, request);
    expect(result.identification).toMatchObject({ deviceType: null, manufacturer: null, confidence: null });
    expect(result.missingEvidence).toContain('HTTP response headers');
  });

  it('labels OUI evidence as a manufacturer clue and caps its confidence', async () => {
    const clueSnapshot = structuredClone(snapshot);
    clueSnapshot.endpoints[0].macAddress = '3c:71:bf:32:4b:44';
    clueSnapshot.rawEvidence[0].evidence.macAddress = '3c:71:bf:32:4b:44';
    generate.mockImplementation(async (input: { userPrompt: string }) => {
      const evidence = JSON.parse(input.userPrompt).evidence as Array<{ id: string; attribute: string }>;
      const oui = evidence.find(item => item.attribute === 'mac_oui.interface_vendor_clue')!;
      return { provider: 'test-provider', model: 'test-model', text: JSON.stringify(answer({ findings: [{
        kind: 'manufacturer_clue', claim: 'The network interface vendor is Espressif Inc.', confidence: 0.99,
        supportingEvidenceIds: [oui.id], missingEvidence: ['Device manufacturer is not established'],
      }] })) };
    });
    const result = await service.investigate(clueSnapshot, request);
    expect(result.findings[0]).toMatchObject({ kind: 'manufacturer_clue', confidence: 0.7 });
  });

  it('requires hypotheses to state missing evidence and caps their confidence', async () => {
    generate.mockImplementation(async (input: { userPrompt: string }) => {
      const port = (JSON.parse(input.userPrompt).evidence as Array<{ id: string; attribute: string }>).find(item => item.attribute === 'port.80.open')!;
      return { provider: 'test-provider', model: 'test-model', text: JSON.stringify(answer({ findings: [{
        kind: 'hypothesis', claim: 'This may be a small embedded device.', confidence: 0.99,
        supportingEvidenceIds: [port.id], missingEvidence: ['A device-native identity response'],
      }] })) };
    });
    const result = await service.investigate(snapshot, request);
    expect(result.findings[0]).toMatchObject({ kind: 'hypothesis', confidence: 0.5 });
  });

  it('rejects hypotheses that omit their evidence gaps', async () => {
    generate.mockImplementation(async (input: { userPrompt: string }) => {
      const port = (JSON.parse(input.userPrompt).evidence as Array<{ id: string; attribute: string }>).find(item => item.attribute === 'port.80.open')!;
      return { provider: 'test-provider', model: 'test-model', text: JSON.stringify(answer({ findings: [{
        kind: 'hypothesis', claim: 'This may be a camera.', confidence: 0.9,
        supportingEvidenceIds: [port.id], missingEvidence: [],
      }] })) };
    });
    await expect(service.investigate(snapshot, request)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('surfaces provider failures without fabricating a report', async () => {
    generate.mockRejectedValue(new Error('provider unavailable'));
    await expect(service.investigate(snapshot, request)).rejects.toThrow('provider unavailable');
  });
});
