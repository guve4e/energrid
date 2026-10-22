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
    expect(payload.endpoint).toMatchObject({ scanOutcome: 'responded_during_scan', currentReachabilityEstablished: false });
    expect(payload.endpoint).not.toHaveProperty('status');
    expect(prompt).not.toContain('should-not-leak');
    expect(prompt).not.toContain('secret=');
    expect(generate.mock.calls[0][0].outputSchema).toBeDefined();
  });

  it('gives the investigator route-derived gateway role and carefully scoped historical context', async () => {
    const gatewaySnapshot = structuredClone(snapshot);
    gatewaySnapshot.scopes[0].interfaceName = 'en0';
    gatewaySnapshot.runtime!.observedAt = '2026-10-21T10:01:00.000Z';
    gatewaySnapshot.runtime!.routes = [{ destination: '0.0.0.0/0', family: 'IPv4', gateway: '192.168.7.48', interfaceName: 'en0', evidence: 'netstat_route_table' }];
    gatewaySnapshot.runtime!.localScopes = [{ cidr: '192.168.7.0/24', interfaceName: 'en0' }];
    gatewaySnapshot.runtime!.configuredScopes = [{ id: 'eero', name: 'Eero LAN', cidr: '192.168.7.0/24', interfaceName: 'en0', reachability: 'on_link', boundedScanEligible: true, reason: 'Local interface route.' }];
    gatewaySnapshot.endpoints[0].macAddress = '3c:71:bf:32:4b:44';
    const prior = structuredClone(gatewaySnapshot);
    prior.scanId = 'scan-eero-prior';
    prior.completedAt = '2026-10-20T10:01:00.000Z';
    prior.endpoints[0].discoveredAt = prior.completedAt;
    prior.runtime!.observedAt = prior.completedAt;
    prior.endpoints[0].macAddress = 'aa:bb:cc:dd:ee:ff';
    generate.mockImplementation(async (input: { userPrompt: string }) => {
      const payload = JSON.parse(input.userPrompt);
      const port = payload.evidence.find((item: { attribute: string }) => item.attribute === 'port.80.open');
      return { provider: 'test', model: 'test', text: JSON.stringify(answer({ findings: [{
        kind: 'observed_fact', claim: 'TCP port 80 responded during a historical scan.', confidence: 1,
        supportingEvidenceIds: [port.id], missingEvidence: ['Router make and model'],
      }], missingEvidence: ['Router make and model'] })) };
    });

    const result = await service.investigate(gatewaySnapshot, request, false, [prior]);
    const [input] = generate.mock.calls[0];
    const payload = JSON.parse(input.userPrompt);
    expect(payload.networkRole).toMatchObject({ label: 'Observed default gateway', observer: { host: 'mac.local', interfaceName: 'en0' }, observedAt: gatewaySnapshot.runtime!.observedAt });
    expect(payload.historicalAddressContext).toEqual([expect.objectContaining({ correlation: 'address_only_unlinked', identityContinuityEstablished: false })]);
    expect(payload.endpoint.currentReachabilityEstablished).toBe(false);
    expect(input.systemPrompt).toContain('network role such as default gateway is an observed route role');
    expect(input.systemPrompt).toContain('never "currently online"');
    expect(result.networkRole).toMatchObject({ role: 'default_gateway', observer: { host: 'mac.local', interfaceName: 'en0' } });
    expect(result.findings[0]).toMatchObject({ kind: 'observed_fact', supportingEvidenceIds: [result.networkRole!.id] });
    expect(result.summary).toContain('router make and model remain unknown');
  });

  it('combines HouseNet route role, ASUS OUI clue, and saved HTTP response without claiming a model', async () => {
    const houseNetSnapshot = structuredClone(snapshot);
    houseNetSnapshot.scanId = 'scan-housenet-pi';
    houseNetSnapshot.collector = { id: 'pi/eth0', host: 'energrid-pi', interfaces: ['eth0'] };
    houseNetSnapshot.scopes = [{ id: 'housenet', name: 'HouseNet', cidr: '192.168.1.0/24', interfaceName: 'eth0', complete: true, gatewayIpsObserved: [] }];
    houseNetSnapshot.runtime!.observer = { id: 'observer/pi', host: 'energrid-pi', platform: 'linux' };
    houseNetSnapshot.runtime!.routes = [{ destination: '0.0.0.0/0', family: 'IPv4', gateway: '192.168.1.1', interfaceName: 'eth0', evidence: 'ip_route_table' }];
    houseNetSnapshot.runtime!.localScopes = [{ cidr: '192.168.1.0/24', interfaceName: 'eth0' }];
    houseNetSnapshot.runtime!.configuredScopes = [{ id: 'housenet', name: 'HouseNet', cidr: '192.168.1.0/24', interfaceName: 'eth0', reachability: 'on_link', boundedScanEligible: true, reason: 'Direct route observed.' }];
    houseNetSnapshot.endpoints = [{
      id: 'house-gateway', ipAddress: '192.168.1.1', networkZoneId: 'housenet', networkZoneName: 'HouseNet',
      macAddress: '00:11:2f:12:34:56', protocol: 'unknown', confidence: 0.5, status: 'online',
      discoveredAt: '2026-10-21T10:00:40.000Z', reason: 'Responded during Nmap host discovery',
      observations: [
        { source: 'nmap', attribute: 'host.discovered', value: true, observedAt: '2026-10-21T10:00:35.000Z', scopeId: 'housenet', interfaceName: 'eth0', method: 'nmap_host_discovery' },
        { source: 'tcp', attribute: 'port.80.open', value: true, observedAt: '2026-10-21T10:00:40.000Z', scopeId: 'housenet', interfaceName: 'eth0', method: 'nmap_tcp_connect_service_scan' },
        { source: 'tcp', attribute: 'port.80.service', value: 'http', observedAt: '2026-10-21T10:00:40.000Z', scopeId: 'housenet', interfaceName: 'eth0', method: 'nmap_tcp_connect_service_scan' },
        { source: 'http_rpc', attribute: 'http.server_header', value: 'ASUS embedded web server', observedAt: '2026-10-21T10:00:40.000Z', scopeId: 'housenet', interfaceName: 'eth0', method: 'read_only_http_identification' },
        { source: 'http_rpc', attribute: 'http.status_code', value: 200, observedAt: '2026-10-21T10:00:40.000Z', scopeId: 'housenet', interfaceName: 'eth0', method: 'read_only_http_identification' },
      ],
    }];
    houseNetSnapshot.rawEvidence = [{
      observedAt: '2026-10-21T10:00:35.000Z', source: 'nmap', scopeId: 'housenet',
      evidence: { ipAddress: '192.168.1.1', macAddress: '00:11:2f:12:34:56' },
    }];
    const houseRequest = { scanId: houseNetSnapshot.scanId, scopeId: 'housenet', ipAddress: '192.168.1.1', endpointId: 'house-gateway' };
    generate.mockImplementation(async (input: { userPrompt: string }) => {
      const payload = JSON.parse(input.userPrompt);
      const port = payload.evidence.find((item: { attribute: string }) => item.attribute === 'port.80.open');
      return { provider: 'test', model: 'test', text: JSON.stringify(answer({ findings: [{
        kind: 'observed_fact', claim: 'HTTP port 80 responded during the scan.', confidence: 1,
        supportingEvidenceIds: [port.id], missingEvidence: [],
      }] })) };
    });

    const result = await service.investigate(houseNetSnapshot, houseRequest);
    const payload = JSON.parse(generate.mock.calls[0][0].userPrompt);
    const asusClue = result.findings.find(item => item.kind === 'manufacturer_clue');

    expect(result.networkRole).toMatchObject({ role: 'default_gateway', ipAddress: '192.168.1.1', observer: { host: 'energrid-pi', interfaceName: 'eth0' } });
    expect(payload.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'nmap', attribute: 'host.discovered', value: true, confidence: 'observed' }),
      expect.objectContaining({ attribute: 'http.server_header', value: 'ASUS embedded web server', confidence: 'reported' }),
      expect.objectContaining({ attribute: 'http.status_code', value: 200 }),
      expect.objectContaining({ attribute: 'mac_oui.interface_vendor_clue', value: 'ASUSTek COMPUTER INC.' }),
    ]));
    expect(asusClue?.confidence).toBeLessThanOrEqual(0.7);
    expect(asusClue?.claim).toContain('network-interface vendor clue');
    expect(asusClue?.missingEvidence).toEqual(expect.arrayContaining(['Verified router manufacturer and model']));
    expect(result.findings[0]).toMatchObject({ kind: 'observed_fact', claim: expect.stringContaining('Observed default gateway'), confidence: 1 });
    expect(result.findings.some(item => item.claim.includes('server header: ASUS embedded web server'))).toBe(true);
    expect(result.summary).toContain('ASUSTek COMPUTER INC.');
    expect(result.identification).toMatchObject({ deviceType: null, manufacturer: null, confidence: null });
  });


  it('preserves identity clues when a scan contains many low-value port observations', async () => {
    const crowded = structuredClone(snapshot);
    const endpoint = crowded.endpoints[0];
    endpoint.macAddress = '00:11:2f:12:34:56';

    const observedAt = '2026-10-21T10:00:40.000Z';
    const noisyObservations = Array.from({ length: 50 }, (_, index) => ({
      source: 'tcp' as const,
      attribute: `port.${3000 + index}.open`,
      value: true,
      observedAt,
      scopeId: 'eero',
    }));

    endpoint.observations = [
      ...noisyObservations,
      { source: 'nmap', attribute: 'host.discovered', value: true, observedAt, scopeId: 'eero' },
      { source: 'http_rpc', attribute: 'http.server_header', value: 'ASUS embedded web server', observedAt, scopeId: 'eero' },
      ...endpoint.observations!,
    ];

    generate.mockImplementation(async (input: { userPrompt: string }) => {
      const payload = JSON.parse(input.userPrompt);
      const header = payload.evidence.find(
        (item: { attribute: string }) => item.attribute === 'http.server_header',
      );

      return {
        provider: 'test',
        model: 'test',
        text: JSON.stringify(answer({
          findings: [{
            kind: 'observed_fact',
            claim: 'HTTP server response was observed.',
            confidence: 1,
            supportingEvidenceIds: [header.id],
            missingEvidence: [],
          }],
        })),
      };
    });

    const result = await service.investigate(crowded, request);
    const payload = JSON.parse(generate.mock.calls[0][0].userPrompt);

    expect(payload.evidence.length).toBeLessThanOrEqual(32);

    expect(payload.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        attribute: 'mac_oui.interface_vendor_clue',
        value: 'ASUSTek COMPUTER INC.',
      }),
      expect.objectContaining({
        attribute: 'http.server_header',
        value: 'ASUS embedded web server',
      }),
      expect.objectContaining({
        attribute: 'host.discovered',
        value: true,
      }),
    ]));

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'manufacturer_clue',
        confidence: 0.7,
      }),
    ]));

    expect(result.identification.manufacturer).toBeNull();
  });

  it('carries prior protocol identity history only when the observed MAC also matches', async () => {
    const prior = structuredClone(snapshot);
    prior.scanId = 'scan-prior';
    prior.completedAt = '2026-10-20T10:01:00.000Z';
    prior.endpoints[0].id = 'shellyplus1-old';
    prior.endpoints[0].vendor = 'Shelly';
    prior.endpoints[0].protocol = 'http';
    prior.endpoints[0].discoveredAt = prior.completedAt;
    prior.endpoints[0].observations = [{ source: 'http_rpc', attribute: 'shelly.device_id', value: 'shellyplus1-old', observedAt: prior.completedAt, scopeId: 'eero' }];
    generate.mockImplementation(async (input: { userPrompt: string }) => {
      const payload = JSON.parse(input.userPrompt);
      const port = payload.evidence.find((item: { attribute: string }) => item.attribute === 'port.80.open');
      return { provider: 'test', model: 'test', text: JSON.stringify(answer({ findings: [{
        kind: 'observed_fact', claim: 'A TCP port responded during this scan.', confidence: 1, supportingEvidenceIds: [port.id], missingEvidence: [],
      }] })) };
    });
    await service.investigate(snapshot, request, false, [prior]);
    const history = JSON.parse(generate.mock.calls[0][0].userPrompt).historicalAddressContext;
    expect(history).toEqual([expect.objectContaining({
      scanId: 'scan-prior', correlation: 'matching_observed_mac', observedMac: snapshot.endpoints[0].macAddress,
      identityContinuityEstablished: true, protocolIdentities: [{ value: 'shellyplus1-old', observedAt: prior.completedAt }],
    })]);
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
