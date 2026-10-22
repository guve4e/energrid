import {
  buildNmapArguments,
  NmapNetworkEvidenceAdapter,
  parseNmapXml,
  type NmapCommandRunner,
} from './nmap-network-evidence.adapter';

const xml = `<?xml version="1.0"?>
<!DOCTYPE nmaprun>
<nmaprun scanner="nmap" version="7.95">
  <host starttime="1792560000" endtime="1792560002">
    <status state="up" reason="user-set" />
    <address addr="192.168.7.21" addrtype="ipv4" />
    <address addr="78:ee:4c:cf:42:68" addrtype="mac" vendor="Untrusted label" />
    <hostnames><hostname name="sensor.local" type="PTR" /></hostnames>
    <ports>
      <port protocol="tcp" portid="80"><state state="open" reason="syn-ack" /><service name="http" product="Example" version="1.2" /></port>
      <port protocol="tcp" portid="22"><state state="closed" reason="conn-refused" /></port>
    </ports>
  </host>
  <runstats><finished exit="success" /><hosts up="1" down="0" total="1" /></runstats>
</nmaprun>`;

const scope = {
  id: 'eero',
  name: 'Eero',
  cidr: '192.168.7.0/24',
  interfaceName: 'en0',
  seedIps: [],
};

describe('Nmap XML evidence adapter', () => {
  it('does not report Nmap evidence collection when the scanner is disabled', async () => {
    const runner: NmapCommandRunner = async () => ({ stdout: 'Nmap version 7.95', stderr: '' });
    const adapter = new NmapNetworkEvidenceAdapter(runner);

    const result = await adapter.scan([scope], { enabled: false });

    expect(result.capability).toEqual({ available: true, version: '7.95' });
    expect(result.methods).toEqual([]);
    expect(result.scopes[0].failure).toContain('disabled');
  });

  it('parses endpoint, hostname and open service evidence without treating assumed-up as reachability', () => {
    const parsed = parseNmapXml(xml, {
      scopeId: 'eero',
      scopeCidr: '192.168.7.0/24',
      interfaceName: 'en0',
      observedAt: '2026-10-21T00:00:00.000Z',
      onLink: true,
    });

    expect(parsed.hosts).toHaveLength(1);
    expect(parsed.hosts[0]).toMatchObject({
      ipAddress: '192.168.7.21',
      macAddress: '78:ee:4c:cf:42:68',
      hostname: 'sensor.local',
      status: 'online',
      observations: [
        expect.objectContaining({ source: 'tcp', attribute: 'port.80.open', value: true }),
        expect.objectContaining({ source: 'tcp', attribute: 'port.80.service', value: 'http Example 1.2' }),
        expect.objectContaining({ source: 'tcp', attribute: 'port.22.closed', value: false }),
      ],
    });
    expect(parsed.complete).toBe(true);
  });

  it('does not attribute an XML MAC from a routed scope to the remote endpoint', () => {
    const parsed = parseNmapXml(xml, {
      scopeId: 'housenet',
      scopeCidr: '192.168.1.0/24',
      observedAt: '2026-10-21T00:00:00.000Z',
      onLink: false,
    });

    expect(parsed.hosts).toEqual([]);
  });

  it('does not invent an endpoint from a -Pn user-set host with only filtered ports', () => {
    const filtered = xml
      .replace('<address addr="78:ee:4c:cf:42:68" addrtype="mac" vendor="Untrusted label" />', '')
      .replace('<hostnames><hostname name="sensor.local" type="PTR" /></hostnames>', '')
      .replace('state="open" reason="syn-ack"', 'state="filtered" reason="no-response"')
      .replace('<port protocol="tcp" portid="22"><state state="closed" reason="conn-refused" /></port>', '')
      .replace('<service name="http" product="Example" version="1.2" />', '');
    const parsed = parseNmapXml(filtered, {
      scopeId: 'eero', scopeCidr: '192.168.7.0/24', observedAt: '2026-10-21T00:00:00.000Z', onLink: false,
    });
    expect(parsed.hosts).toEqual([]);
    expect(parsed.complete).toBe(true);
  });

  it('rejects malformed XML and ignores out-of-scope endpoint records', () => {
    expect(() => parseNmapXml('<nmaprun><host>', {
      scopeId: 'eero', scopeCidr: '192.168.7.0/24', observedAt: '2026-10-21T00:00:00.000Z', onLink: true,
    })).toThrow();

    const outOfScope = xml.replace('192.168.7.21', '192.168.1.21');
    expect(parseNmapXml(outOfScope, {
      scopeId: 'eero', scopeCidr: '192.168.7.0/24', observedAt: '2026-10-21T00:00:00.000Z', onLink: true,
    }).hosts).toEqual([]);
  });

  it('uses bounded argument-array invocation and reports capability and complete scope coverage', async () => {
    const calls: Array<{ command: string; args: string[]; timeout?: number }> = [];
    const runner: NmapCommandRunner = async (command, args, options) => {
      calls.push({ command, args, timeout: options.timeout });
      return { stdout: args[0] === '--version' ? 'Nmap version 7.95 ( https://nmap.org )' : xml, stderr: '' };
    };
    const adapter = new NmapNetworkEvidenceAdapter(runner, () => ({
      en0: [{ address: '192.168.7.10', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:01', internal: false, cidr: '192.168.7.10/24' }],
    }), () => new Date('2026-10-21T00:00:00.000Z'));

    const oneHostScope = { ...scope, cidr: '192.168.7.21/32' };
    const result = await adapter.scan([oneHostScope], { enabled: true, maxHosts: 254, timeoutMs: 10000 });

    expect(result.capability).toEqual({ available: true, version: '7.95' });
    expect(result.scopes).toEqual([expect.objectContaining({ scopeId: 'eero', complete: true, targetCount: 1 })]);
    expect(result.hosts).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: 'nmap', args: ['--version'] });
    expect(calls[1].args).toContain('-sn');
    expect(calls[1].args).not.toContain('-sT');
    expect(calls[1].args).not.toContain('-sV');
    expect(calls[2].args).toContain('-oX');
    expect(calls[2].args).toContain('-sT');
    expect(calls[2].args).toContain('-sV');
    expect(calls[2].args).toContain('-e');
    expect(calls[2].args.at(-1)).toBe('192.168.7.21');
    expect(calls[1].timeout).toBeGreaterThanOrEqual(9000);
    expect(calls[1].timeout).toBeLessThanOrEqual(10000);
    expect(calls[2].timeout).toBeGreaterThanOrEqual(9000);
    expect(calls[2].timeout).toBeLessThanOrEqual(10000);
  });

  it('discovers hosts once, then limits service identification to discovered hosts and configured seeds', async () => {
    const calls: string[][] = [];
    const discoveryXml = `<nmaprun><host endtime="1792560001"><status state="up"/><address addr="192.168.7.21" addrtype="ipv4"/><address addr="78:ee:4c:cf:42:68" addrtype="mac"/></host><runstats><finished exit="success"/><hosts up="1" down="253" total="254"/></runstats></nmaprun>`;
    const serviceXml = `<nmaprun><host endtime="1792560002"><status state="up"/><address addr="192.168.7.21" addrtype="ipv4"/><ports><port protocol="tcp" portid="80"><state state="open"/><service name="http"/></port></ports></host><runstats><finished exit="success"/><hosts up="1" down="1" total="2"/></runstats></nmaprun>`;
    const runner: NmapCommandRunner = async (_command, args) => {
      calls.push(args);
      if (args[0] === '--version') return { stdout: 'Nmap version 7.95', stderr: '' };
      return { stdout: args.includes('-sn') ? discoveryXml : serviceXml, stderr: '' };
    };
    const adapter = new NmapNetworkEvidenceAdapter(runner, () => ({
      en0: [{ address: '192.168.7.10', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:01', internal: false, cidr: '192.168.7.10/24' }],
    }), () => new Date('2026-10-21T00:00:00.000Z'));

    const result = await adapter.scan([{ ...scope, seedIps: ['192.168.7.22'] }], { enabled: true, maxHosts: 254 });

    expect(calls).toHaveLength(3); // version, one host-discovery pass, one service pass
    expect(calls[1]).toContain('-sn');
    expect(calls[1]).not.toContain('-sT');
    expect(calls[1]).not.toContain('-sV');
    expect(calls[1].slice(-254)).toHaveLength(254);
    expect(calls[2]).toContain('-sT');
    expect(calls[2]).toContain('-sV');
    expect(calls[2].slice(-2)).toEqual(['192.168.7.21', '192.168.7.22']);
    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]).toMatchObject({ ipAddress: '192.168.7.21', macAddress: '78:ee:4c:cf:42:68' });
    expect(result.hosts[0].observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'nmap', method: 'nmap_host_discovery', attribute: 'host.discovered', value: true }),
      expect.objectContaining({ method: 'nmap_tcp_connect_service_scan', attribute: 'port.80.open', value: true }),
    ]));
    expect(result.scopes[0]).toMatchObject({
      complete: true,
      hostDiscovery: { complete: true, targetCount: 254, hostsReported: 1 },
      serviceEnrichment: { complete: true, targetCount: 2, hostsReported: 1 },
    });
    expect(result.scopes[0].hostDiscovery?.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.scopes[0].serviceEnrichment?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('preserves host-discovery evidence when service enrichment times out', async () => {
    const discoveryXml = `<nmaprun><host endtime="1792560001"><status state="up"/><address addr="192.168.7.21" addrtype="ipv4"/></host><runstats><finished exit="success"/><hosts up="1" down="0" total="1"/></runstats></nmaprun>`;
    const runner: NmapCommandRunner = async (_command, args) => {
      if (args[0] === '--version') return { stdout: 'Nmap version 7.95', stderr: '' };
      if (args.includes('-sn')) return { stdout: discoveryXml, stderr: '' };
      const error = new Error('Command timed out') as Error & { killed: boolean };
      error.killed = true;
      throw error;
    };
    const adapter = new NmapNetworkEvidenceAdapter(runner, () => ({}), () => new Date('2026-10-21T00:00:00.000Z'));

    const result = await adapter.scan([{ ...scope, cidr: '192.168.7.21/32' }], { enabled: true });

    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]).toMatchObject({ ipAddress: '192.168.7.21', reason: expect.stringContaining('host-discovery response') });
    expect(result.scopes[0]).toMatchObject({
      complete: false,
      hostDiscovery: { complete: true, hostsReported: 1 },
      serviceEnrichment: { complete: false, failure: 'Nmap scan reached its time limit.' },
    });
    expect(result.failures.join(' ')).toContain('time limit');
    expect(result.limitations.join(' ')).toContain('remain unknown');
  });

  it('records the routed egress interface without promoting a remote XML MAC to link evidence', async () => {
    const calls: string[][] = [];
    const runner: NmapCommandRunner = async (_command, args) => {
      calls.push(args);
      return { stdout: args[0] === '--version' ? 'Nmap version 7.95' : xml, stderr: '' };
    };
    const adapter = new NmapNetworkEvidenceAdapter(
      runner,
      () => ({}),
      () => new Date('2026-10-21T00:00:00.000Z'),
      async () => ({ interfaceName: 'en0' }),
    );
    const result = await adapter.scan([{ ...scope, cidr: '192.168.7.21/32' }], { enabled: true });

    expect(result.scopes[0].interfaceName).toBe('en0');
    expect(calls[1]).toContain('en0');
    expect(result.hosts[0].macAddress).toBeUndefined();
  });

  it('fails closed for invalid or over-limit scopes without starting a subprocess', async () => {
    const runner = jest.fn<NmapCommandRunner>();
    const adapter = new NmapNetworkEvidenceAdapter(runner);

    const result = await adapter.scan([{ ...scope, cidr: '192.168.0.0/16' }], { maxHosts: 254 });

    expect(runner).not.toHaveBeenCalled();
    expect(result.scopes[0]).toMatchObject({ complete: false, failure: expect.stringContaining('Nmap limit') });
  });

  it('rejects non-address targets and invalid interface arguments before process invocation', () => {
    expect(() => buildNmapArguments(['192.168.7.1; echo unsafe'])).toThrow('validated IPv4 targets');
    expect(() => buildNmapArguments(['192.168.7.1'], 'en0;echo unsafe')).toThrow('interface name is invalid');
    expect(() => buildNmapArguments(Array.from({ length: 255 }, (_, i) => `10.0.0.${i + 1}`))).toThrow('254');
  });

  it('reports missing Nmap as a limitation rather than fabricating endpoint results', async () => {
    const adapter = new NmapNetworkEvidenceAdapter(async () => {
      throw new Error('spawn nmap ENOENT');
    });

    const result = await adapter.scan([scope], { enabled: true });

    expect(result.capability.available).toBe(false);
    expect(result.hosts).toEqual([]);
    expect(result.scopes[0].complete).toBe(false);
    expect(result.limitations.join(' ')).toContain('Nmap is unavailable');
  });

  it('stops a running scan when its AbortSignal is cancelled', async () => {
    const controller = new AbortController();
    const runner: NmapCommandRunner = async (_command, args, options) => {
      if (args[0] === '--version') return { stdout: 'Nmap version 7.95', stderr: '' };
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        controller.abort();
      });
    };
    const adapter = new NmapNetworkEvidenceAdapter(runner);

    const result = await adapter.scan([scope], { enabled: true, signal: controller.signal });

    expect(result.cancelled).toBe(true);
    expect(result.scopes[0].complete).toBe(false);
    expect(result.failures).toContain('Nmap scan was cancelled by the operator.');
  });

  it('records a process timeout as incomplete coverage rather than absence', async () => {
    const adapter = new NmapNetworkEvidenceAdapter(async (_command, args) => {
      if (args[0] === '--version') return { stdout: 'Nmap version 7.95', stderr: '' };
      const error = new Error('Command timed out') as Error & { killed: boolean };
      error.killed = true;
      throw error;
    }, () => ({}), () => new Date('2026-10-21T00:00:00.000Z'), async () => ({ interfaceName: 'en0' }));

    const result = await adapter.scan([{ ...scope, cidr: '192.168.7.21/32' }], { enabled: true });

    expect(result.scopes[0]).toMatchObject({ complete: false, failure: 'Nmap scan reached its time limit.' });
    expect(result.failures.join(' ')).toContain('time limit');
    expect(result.limitations.join(' ')).toContain('remain unknown');
  });
});
