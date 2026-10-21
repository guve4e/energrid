import type { NetworkDiscoveredDevice, NetworkDiscoveryZone } from '../devices/device-registry.types';
import { httpIdentityProbePolicy, ReadOnlyHttpIdentityProbe, type HttpHeadTransport } from './read-only-http-identity-probe';

describe('ReadOnlyHttpIdentityProbe', () => {
  const target: NetworkDiscoveredDevice = {
    id: 'lan-host-1', ipAddress: '192.168.1.133', networkZoneId: 'upstream',
    networkZoneName: 'Upstream LAN', protocol: 'unknown', confidence: 0.6,
    status: 'online', discoveredAt: '2026-10-20T09:00:00.000Z', reason: 'fixture',
  };
  const zones: NetworkDiscoveryZone[] = [{
    id: 'upstream', name: 'Upstream LAN', cidr: '192.168.1.0/24', seedIps: [],
  }];
  const now = () => Date.parse('2026-10-20T09:00:10.000Z');

  it('probes only the current server-selected private endpoint after approval', async () => {
    const request = jest.fn().mockResolvedValue({
      statusCode: 404, headers: { server: 'fixture-device', 'content-type': 'text/html' },
    });
    const probe = new ReadOnlyHttpIdentityProbe({ request } as HttpHeadTransport, now);

    const result = await probe.run(target, zones, true);

    expect(result).toMatchObject({ outcome: 'completed', statusCode: 404, ipAddress: target.ipAddress, method: 'HEAD', path: '/', redirects: 'not_followed' });
    expect(request).toHaveBeenCalledWith(target.ipAddress, 80, 2500, 4096);
  });

  it('uses a fixed allowlisted URL, bounded headers, no body, and does not follow redirects', async () => {
    const request = jest.fn().mockResolvedValue({ statusCode: 302, headers: { server: 'fixture', contentType: 'text/html' } });
    const probe = new ReadOnlyHttpIdentityProbe({ request } as HttpHeadTransport, now);
    const result = await probe.run(target, zones, true);

    expect(httpIdentityProbePolicy).toEqual({ method: 'HEAD', path: '/', port: 80, timeoutMs: 2500, maxHeaderBytes: 4096, redirects: 'not_followed', maxBodyBytes: 0 });
    expect(result).toMatchObject({ outcome: 'completed', statusCode: 302, redirects: 'not_followed' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects a probe without explicit operator approval', async () => {
    const request = jest.fn();
    const probe = new ReadOnlyHttpIdentityProbe({ request } as HttpHeadTransport, now);
    const before = structuredClone(target);

    await expect(probe.run(target, zones, false)).resolves.toMatchObject({
      outcome: 'rejected', reasonCode: 'operator_approval_required',
    });
    expect(request).not.toHaveBeenCalled();
    expect(target).toEqual(before);
  });

  it.each([
    ['out-of-scope IP', { ...target, ipAddress: '192.168.2.9' }],
    ['public IP', { ...target, ipAddress: '8.8.8.8' }],
    ['link-local metadata address', { ...target, ipAddress: '169.254.169.254' }],
    ['stale observation', { ...target, discoveredAt: '2026-10-20T08:50:00.000Z' }],
    ['non-live observation', { ...target, status: 'unknown' as const }],
  ])('rejects %s before transport access', async (_label, candidate) => {
    const request = jest.fn();
    const probe = new ReadOnlyHttpIdentityProbe({ request } as HttpHeadTransport, now);

    await expect(probe.run(candidate, zones, true)).resolves.toMatchObject({ outcome: 'rejected' });
    expect(request).not.toHaveBeenCalled();
  });

  it('records a bounded failure when the transport times out', async () => {
    const request = jest.fn().mockRejectedValue(new Error('timeout'));
    const probe = new ReadOnlyHttpIdentityProbe({ request } as HttpHeadTransport, now);

    await expect(probe.run(target, zones, true)).resolves.toMatchObject({
      outcome: 'failed', reasonCode: 'http_probe_timeout_or_transport_error',
    });
  });

  it('does not retain credential-like or malformed response headers', async () => {
    const request = jest.fn().mockResolvedValue({
      statusCode: 200,
      headers: { server: 'Bearer secret-token', contentType: 'text/html; token=secret' },
    });
    const probe = new ReadOnlyHttpIdentityProbe({ request } as HttpHeadTransport, now);

    const result = await probe.run(target, zones, true);

    expect(result).toMatchObject({ outcome: 'completed', statusCode: 200 });
    expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(JSON.stringify(result)).not.toContain('token=secret');
  });
});
