import {
  EnergridFirmwareDiagnosticsHttpAdapter,
  FirmwareDiagnosticsCollectionError,
} from './energrid-firmware-diagnostics-http.adapter';

const payload = {
  schemaVersion: 1,
  deviceId: 'esp8266:324864',
  firmwareVersion: '0.3.1',
  bootSessionId: 'esp8266-324864-1234abcd',
  uptimeMs: 120_000,
  reset: { reason: 'External System', reasonCode: 6, exception: null },
  memory: { freeHeapBytes: 20_000, heapFragmentationPct: 12, largestFreeBlockBytes: 15_000 },
  wifi: { connected: true, rssiDbm: -55, disconnectCount: 1, reconnectCount: 1 },
  sensor: { sampleCount: 10, readFailureCount: 1 },
};

describe('Energrid firmware diagnostics HTTP adapter', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('reads only the fixed diagnostics path with manual redirects and verifies the expected identity', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200, headers: { get: () => '350' }, text: async () => JSON.stringify(payload),
    }) as unknown as typeof fetch;
    const signal = new AbortController().signal;
    const sample = await new EnergridFirmwareDiagnosticsHttpAdapter().collect(
      'http://192.168.1.198/api/v1/identity', 'esp8266:324864', signal,
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = (global.fetch as jest.Mock).mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('http://192.168.1.198/api/v1/diagnostics');
    expect(options.redirect).toBe('manual');
    expect(options.signal).toBe(signal);
    expect(options.headers).toEqual({ Accept: 'application/json', 'Cache-Control': 'no-cache' });
    expect(sample.sensor.readFailureCount).toBe(1);
  });

  it('rejects a different physical identity, redirects, bad responses, and oversized evidence', async () => {
    const adapter = new EnergridFirmwareDiagnosticsHttpAdapter();
    const mockResponse = (body: string, overrides: Record<string, unknown> = {}) => ({
      ok: true, status: 200, headers: { get: () => String(Buffer.byteLength(body)) }, text: async () => body, ...overrides,
    });
    global.fetch = jest.fn().mockResolvedValueOnce(mockResponse(JSON.stringify({ ...payload, deviceId: 'esp8266:ffffff' })))
      .mockResolvedValueOnce(mockResponse('', { status: 302 }))
      .mockResolvedValueOnce(mockResponse('not json'))
      .mockResolvedValueOnce(mockResponse('x'.repeat(4097))) as unknown as typeof fetch;
    const collect = () => adapter.collect('http://192.168.1.198/api/v1/identity', 'esp8266:324864', new AbortController().signal);
    await expect(collect()).rejects.toMatchObject({ reason: 'identity_mismatch' });
    await expect(collect()).rejects.toMatchObject({ reason: 'diagnostics_http_error' });
    await expect(collect()).rejects.toMatchObject({ reason: 'response_invalid' });
    await expect(collect()).rejects.toMatchObject({ reason: 'response_invalid' });
  });

  it('classifies a bounded timeout without exposing the request error', async () => {
    global.fetch = jest.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })) as unknown as typeof fetch;
    await expect(new EnergridFirmwareDiagnosticsHttpAdapter().collect(
      'http://192.168.1.198/api/v1/identity', 'esp8266:324864', new AbortController().signal,
    )).rejects.toBeInstanceOf(FirmwareDiagnosticsCollectionError);
    await expect(new EnergridFirmwareDiagnosticsHttpAdapter().collect(
      'http://192.168.1.198/api/v1/identity', 'esp8266:324864', new AbortController().signal,
    )).rejects.toMatchObject({ reason: 'request_timeout' });
  });
});
