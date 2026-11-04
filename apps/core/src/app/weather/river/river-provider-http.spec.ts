import { Logger } from '@nestjs/common';
import { AppdDanubeProviderService } from './appd-danube-provider.service';
import { DanubePortalProviderService } from './danube-portal-provider.service';
import { fetchRiverHtml } from './river-provider-http';

describe('River provider HTTP reliability', () => {
  const originalFetch = global.fetch;
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

  it('uses a request deadline and rejects oversized declared responses', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response('ignored', {
      headers: { 'content-length': '1048577' },
    }));
    global.fetch = fetchMock as typeof fetch;
    await expect(fetchRiverHtml('https://river.example/data')).rejects.toThrow('size limit');
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('error');
  });

  it('rejects chunked responses beyond the limit even without Content-Length', async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1));
      },
    }));
    global.fetch = jest.fn().mockResolvedValue(response) as typeof fetch;
    await expect(fetchRiverHtml('https://river.example/data')).rejects.toThrow('size limit');
  });

  it('accepts a small HTML response and preserves the content for parsing', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('<table><tr></tr></table>')) as typeof fetch;
    await expect(fetchRiverHtml('https://river.example/data')).resolves.toBe('<table><tr></tr></table>');
  });

  it('passes an abort signal to both providers and returns unavailable on transport failure', async () => {
    const fetchMock = jest.fn().mockRejectedValue(Object.assign(new Error('deadline'), { name: 'TimeoutError' }));
    global.fetch = fetchMock as typeof fetch;
    await expect(new AppdDanubeProviderService().getStations()).resolves.toEqual([]);
    await expect(new DanubePortalProviderService().getStations()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('recovers normally after an upstream failure', async () => {
    const fetchMock = jest.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response('<table></table>'));
    global.fetch = fetchMock as typeof fetch;
    const provider = new AppdDanubeProviderService();
    await expect(provider.getStations()).resolves.toEqual([]);
    await expect(provider.getStations()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
