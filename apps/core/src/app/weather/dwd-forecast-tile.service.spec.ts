import { inflateSync } from 'node:zlib';
import { DwdForecastTileService, modelTimes } from './dwd-forecast-tile.service';
import { xyzTileBounds } from './precipitation-tile-renderer';
import { PALETTE_VERSION } from './precipitation-tile-renderer';

function onePixelGeoTiff(value: number) {
  const tags: Array<[number, number, number, number]> = [
    [256, 3, 1, 1], [257, 3, 1, 1], [258, 3, 1, 64], [259, 3, 1, 1],
    [277, 3, 1, 1], [339, 3, 1, 3], [322, 3, 1, 1], [323, 3, 1, 1],
    [324, 4, 1, 344], [325, 4, 1, 8], [34264, 12, 16, 184], [34735, 3, 16, 312],
  ];
  const image = Buffer.alloc(352);
  image.write('MM', 0); image.writeUInt16BE(42, 2); image.writeUInt32BE(8, 4); image.writeUInt16BE(tags.length, 8);
  tags.forEach(([id, type, count, value], index) => {
    const at = 10 + index * 12;
    image.writeUInt16BE(id, at); image.writeUInt16BE(type, at + 2); image.writeUInt32BE(count, at + 4);
    if (type === 3 && count === 1) image.writeUInt16BE(value, at + 8); else image.writeUInt32BE(value, at + 8);
  });
  [0.0625, 0, 0, 22.90625, 0, -0.0625, 0, 43.84375, 0, 0, 0, 0, 0, 0, 0, 1]
    .forEach((number, index) => image.writeDoubleBE(number, 184 + index * 8));
  [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]
    .forEach((number, index) => image.writeUInt16BE(number, 312 + index * 2));
  image.writeDoubleBE(value, 344);
  return image;
}

const metadata = `<?xml version="1.0"?><wcs:CoverageDescriptions>
<gml:EnvelopeWithTimePeriod srsName="http://www.opengis.net/def/crs/EPSG/0/4326"/>
<wcs:CoverageId>dwd__Icon-eu_reg00625_fd_sl_TOTPREC01H</wcs:CoverageId>
<swe:uom code="kg/m²"/><gml:offsetVector>0.0 0.0625</gml:offsetVector>
<wcs:nativeFormat>image/tiff</wcs:nativeFormat></wcs:CoverageDescriptions>`;
const capabilities = `<?xml version="1.0"?><WMS_Capabilities><Layer><Name>Icon-eu_reg00625_fd_sl_TOTPREC01H</Name>
<Dimension name="time" default="current" units="ISO8601">2026-11-01T13:00:00.000Z/2026-11-02T18:00:00.000Z/PT1H</Dimension>
<Dimension name="REFERENCE_TIME" default="2026-11-01T12:00:00.000Z" units="ISO8601">2026-11-01T12:00:00.000Z</Dimension></Layer></WMS_Capabilities>`;

function alphaAt(image: Buffer, x: number, y: number) {
  const chunks: Buffer[] = [];
  let offset = 8;
  while (offset < image.length) {
    const length = image.readUInt32BE(offset);
    const type = image.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') chunks.push(image.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  return inflateSync(Buffer.concat(chunks))[y * (1 + 256 * 4) + 1 + x * 4 + 3];
}

describe('DWD forecast tile transport', () => {
  const originalFetch = global.fetch;
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-11-01T14:00:00Z')); });
  afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); jest.useRealTimers(); });

  it('proxies and briefly caches the published WMS time dimensions', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(capabilities, { headers: { 'content-type': 'text/xml' } }));
    global.fetch = fetchMock as typeof fetch;
    const service = new DwdForecastTileService();
    await expect(service.capabilities()).resolves.toBe(capabilities);
    await expect(service.capabilities()).resolves.toBe(capabilities);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('request=GetCapabilities');
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.has('probe')).toBe(true);
  });

  it('retries stale upstream capabilities and only caches the current published run', async () => {
    const stale = capabilities.replaceAll('2026-11-01T12:00:00.000Z', '2026-10-28T06:00:00.000Z');
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response(stale, { headers: { 'content-type': 'text/xml' } }))
      .mockResolvedValueOnce(new Response(capabilities, { headers: { 'content-type': 'text/xml' } }));
    global.fetch = fetchMock as typeof fetch;
    const service = new DwdForecastTileService();
    await expect(service.capabilities()).resolves.toBe(capabilities);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('probe'))
      .not.toBe(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('probe'));
  });

  it('requires an explicitly selected valid forecast time and reference run', () => {
    expect(modelTimes('20261101T120000Z', '20261101T200000Z')).toEqual({
      referenceTime: '2026-11-01T12:00:00Z', validTime: '2026-11-01T20:00:00Z',
    });
    expect(() => modelTimes('20261101T120000Z', '20261101T120000Z')).toThrow();
    expect(() => modelTimes('20261101T120000Z', '20261101T203000Z')).toThrow();
    expect(() => modelTimes('20261101T120000Z', 'current')).toThrow();
  });

  it('rejects a run or hour that DWD does not publish before issuing WCS work', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response(capabilities, { headers: { 'content-type': 'text/xml' } }));
    global.fetch = fetchMock as typeof fetch;
    const service = new DwdForecastTileService();
    await expect(service.tile('20261101T060000Z', '20261101T200000Z', 8, 144, 93))
      .rejects.toThrow('DWD does not advertise this forecast run and valid time');
    await expect(service.tile('20261101T120000Z', '20261102T190000Z', 8, 144, 93))
      .rejects.toThrow('DWD does not advertise this forecast run and valid time');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requests exact WCS dimensions and caches only a successfully decoded tile', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response(capabilities, { headers: { 'content-type': 'text/xml' } }))
      .mockResolvedValueOnce(new Response(metadata, { headers: { 'content-type': 'application/xml' } }))
      .mockResolvedValueOnce(new Response(onePixelGeoTiff(0.3154296875), { headers: { 'content-type': 'image/tiff' } }));
    global.fetch = fetchMock as typeof fetch;
    const service = new DwdForecastTileService();
    const image = await service.tile('20261101T120000Z', '20261101T200000Z', 8, 144, 93);
    expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(alphaAt(image, 128, 128)).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const requestUrl = new URL(fetchMock.mock.calls[2][0] as string);
    const [latitudeSubset, longitudeSubset] = requestUrl.searchParams.getAll('subset');
    const latitudeBounds = /Lat\(([^,]+),([^)]+)\)/.exec(latitudeSubset);
    const longitudeBounds = /Long\(([^,]+),([^)]+)\)/.exec(longitudeSubset);
    if (!latitudeBounds || !longitudeBounds) throw new Error('WCS request omitted geographic subset bounds');
    const south = Number(latitudeBounds[1]); const north = Number(latitudeBounds[2]);
    const west = Number(longitudeBounds[1]); const east = Number(longitudeBounds[2]);
    expect((south - 29.46875) / 0.0625).toBeCloseTo(Math.round((south - 29.46875) / 0.0625), 8);
    expect((north - 29.46875) / 0.0625).toBeCloseTo(Math.round((north - 29.46875) / 0.0625), 8);
    expect((west + 23.53125) / 0.0625).toBeCloseTo(Math.round((west + 23.53125) / 0.0625), 8);
    expect((east + 23.53125) / 0.0625).toBeCloseTo(Math.round((east + 23.53125) / 0.0625), 8);
    const requested = xyzTileBounds(8, 144, 93);
    expect(west).toBeLessThanOrEqual(requested.west); expect(east).toBeGreaterThanOrEqual(requested.east);
    expect(south).toBeLessThanOrEqual(requested.south); expect(north).toBeGreaterThanOrEqual(requested.north);
    expect(requestUrl.searchParams.getAll('subset')).toEqual(expect.arrayContaining([
      'time("2026-11-01T20:00:00Z")', 'REFERENCE_TIME("2026-11-01T12:00:00Z")',
    ]));
    await expect(service.tile('20261101T120000Z', '20261101T200000Z', 8, 144, 93)).resolves.toBe(image);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(PALETTE_VERSION).toBe('precip-v6');
  });

  it('retries a transient no-data response and caches only the valid TIFF tile', async () => {
    const noCoverage = `<?xml version="1.0"?><ows:ExceptionReport><ows:ExceptionText>No data available</ows:ExceptionText></ows:ExceptionReport>`;
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response(capabilities, { headers: { 'content-type': 'text/xml' } }))
      .mockResolvedValueOnce(new Response(metadata, { headers: { 'content-type': 'application/xml' } }))
      .mockResolvedValueOnce(new Response(noCoverage, { headers: { 'content-type': 'application/xml' } }))
      .mockResolvedValueOnce(new Response(onePixelGeoTiff(0.315), { headers: { 'content-type': 'image/tiff' } }));
    global.fetch = fetchMock as typeof fetch;
    const service = new DwdForecastTileService();
    const image = await service.tile('20261101T120000Z', '20261101T200000Z', 8, 144, 93);
    expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await expect(service.tile('20261101T120000Z', '20261101T200000Z', 8, 144, 93)).resolves.toBe(image);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not cache repeated upstream no-data errors and recovers when DWD returns a TIFF', async () => {
    const noCoverage = `<?xml version="1.0"?><ows:ExceptionReport><ows:ExceptionText>No data available</ows:ExceptionText></ows:ExceptionReport>`;
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response(capabilities, { headers: { 'content-type': 'text/xml' } }))
      .mockResolvedValueOnce(new Response(metadata, { headers: { 'content-type': 'application/xml' } }))
      .mockResolvedValueOnce(new Response(noCoverage, { headers: { 'content-type': 'application/xml' } }))
      .mockResolvedValueOnce(new Response(noCoverage, { headers: { 'content-type': 'application/xml' } }))
      .mockResolvedValueOnce(new Response(noCoverage, { headers: { 'content-type': 'application/xml' } }))
      .mockResolvedValueOnce(new Response(onePixelGeoTiff(0.315), { headers: { 'content-type': 'image/tiff' } }));
    global.fetch = fetchMock as typeof fetch;
    const service = new DwdForecastTileService();
    const request = () => service.tile('20261101T120000Z', '20261101T200000Z', 8, 144, 93);
    await expect(request()).rejects.toThrow('DWD forecast coverage is temporarily unavailable');
    await expect(request()).resolves.toMatchObject({ length: expect.any(Number) });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('does not cache network failures and can recover on the next tile request', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response(capabilities, { headers: { 'content-type': 'text/xml' } }))
      .mockResolvedValueOnce(new Response(metadata, { headers: { 'content-type': 'application/xml' } }))
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(new Response(onePixelGeoTiff(0.315), { headers: { 'content-type': 'image/tiff' } }));
    global.fetch = fetchMock as typeof fetch;
    const service = new DwdForecastTileService();
    const request = () => service.tile('20261101T120000Z', '20261101T200000Z', 8, 144, 93);
    await expect(request()).rejects.toThrow('DWD forecast request failed');
    await expect(request()).resolves.toMatchObject({ length: expect.any(Number) });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('maps an upstream timeout to a gateway timeout without retrying the request', async () => {
    const timeout = Object.assign(new Error('upstream deadline'), { name: 'TimeoutError' });
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response(capabilities, { headers: { 'content-type': 'text/xml' } }))
      .mockResolvedValueOnce(new Response(metadata, { headers: { 'content-type': 'application/xml' } }))
      .mockRejectedValueOnce(timeout);
    global.fetch = fetchMock as typeof fetch;
    const service = new DwdForecastTileService();
    await expect(service.tile('20261101T120000Z', '20261101T200000Z', 8, 144, 93))
      .rejects.toThrow('DWD forecast request timed out');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const signal = fetchMock.mock.calls[2][1]?.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('limits per-client concurrency and rotates queued clients fairly', async () => {
    const service = new DwdForecastTileService();
    const pool = service as unknown as {
      activeUpstream: number;
      activeUpstreamByClient: Map<string, number>;
      acquireUpstreamSlot(clientId: string): Promise<void>;
      releaseUpstreamSlot(clientId: string): void;
    };
    await Promise.all([
      pool.acquireUpstreamSlot('client-a'), pool.acquireUpstreamSlot('client-a'),
      pool.acquireUpstreamSlot('client-a'), pool.acquireUpstreamSlot('client-b'),
    ]);
    let a1Granted = false;
    let a2Granted = false;
    let b1Granted = false;
    const a1 = pool.acquireUpstreamSlot('client-a').then(() => { a1Granted = true; });
    const a2 = pool.acquireUpstreamSlot('client-a').then(() => { a2Granted = true; });
    const b1 = pool.acquireUpstreamSlot('client-b').then(() => { b1Granted = true; });
    expect(pool.activeUpstream).toBe(4);
    expect(pool.activeUpstreamByClient.get('client-a')).toBe(3);
    pool.releaseUpstreamSlot('client-b');
    await b1;
    expect(b1Granted).toBe(true);
    expect(a1Granted).toBe(false);
    expect(pool.activeUpstreamByClient.get('client-a')).toBe(3);

    pool.releaseUpstreamSlot('client-a');
    await a1;
    expect(a1Granted).toBe(true);
    pool.releaseUpstreamSlot('client-a');
    await a2;
    expect(a2Granted).toBe(true);

    for (let index = 0; index < 3; index++) pool.releaseUpstreamSlot('client-a');
    pool.releaseUpstreamSlot('client-b');
    expect(pool.activeUpstream).toBe(0);
  });

  it('expires queued requests without consuming capacity or leaking client queue state', async () => {
    const service = new DwdForecastTileService();
    const pool = service as unknown as {
      activeUpstream: number;
      queuedUpstream: number;
      upstreamQueue: Map<string, unknown[]>;
      upstreamQueueOrder: string[];
      acquireUpstreamSlot(clientId: string): Promise<void>;
      releaseUpstreamSlot(clientId: string): void;
    };
    await Promise.all([
      pool.acquireUpstreamSlot('client-a'), pool.acquireUpstreamSlot('client-a'),
      pool.acquireUpstreamSlot('client-a'), pool.acquireUpstreamSlot('client-b'),
    ]);
    const expiredA = pool.acquireUpstreamSlot('client-a');
    const expiredB = pool.acquireUpstreamSlot('client-b');
    const assertions = Promise.all([
      expect(expiredA).rejects.toThrow('DWD forecast queue wait timed out'),
      expect(expiredB).rejects.toThrow('DWD forecast queue wait timed out'),
    ]);

    expect(pool.queuedUpstream).toBe(2);
    await jest.advanceTimersByTimeAsync(8_000);
    await assertions;
    expect(pool.activeUpstream).toBe(4);
    expect(pool.queuedUpstream).toBe(0);
    expect(pool.upstreamQueue.size).toBe(0);
    expect(pool.upstreamQueueOrder).toEqual([]);

    for (const clientId of ['client-a', 'client-a', 'client-a', 'client-b']) {
      pool.releaseUpstreamSlot(clientId);
    }
    await expect(pool.acquireUpstreamSlot('client-a')).resolves.toBeUndefined();
    pool.releaseUpstreamSlot('client-a');
    expect(pool.activeUpstream).toBe(0);
  });

  it('clears a granted queue entry deadline and preserves later clients', async () => {
    const service = new DwdForecastTileService();
    const pool = service as unknown as {
      activeUpstream: number;
      queuedUpstream: number;
      upstreamQueueOrder: string[];
      acquireUpstreamSlot(clientId: string): Promise<void>;
      releaseUpstreamSlot(clientId: string): void;
    };
    await Promise.all([
      pool.acquireUpstreamSlot('client-a'), pool.acquireUpstreamSlot('client-a'),
      pool.acquireUpstreamSlot('client-a'), pool.acquireUpstreamSlot('client-b'),
    ]);
    const first = pool.acquireUpstreamSlot('client-c');
    await jest.advanceTimersByTimeAsync(4_000);
    const later = pool.acquireUpstreamSlot('client-d');
    pool.releaseUpstreamSlot('client-b');
    await first;
    expect(pool.queuedUpstream).toBe(1);

    await jest.advanceTimersByTimeAsync(4_000); // Original deadline: c was granted; d is still queued.
    expect(pool.queuedUpstream).toBe(1);
    expect(pool.upstreamQueueOrder).toEqual(['client-d']);
    pool.releaseUpstreamSlot('client-c');
    await later;
    expect(pool.queuedUpstream).toBe(0);

    for (const clientId of ['client-a', 'client-a', 'client-a', 'client-d']) {
      pool.releaseUpstreamSlot(clientId);
    }
    expect(pool.activeUpstream).toBe(0);
  });

  it('frees global queue capacity after deadlines even when upstream stays stalled', async () => {
    const service = new DwdForecastTileService();
    const pool = service as unknown as {
      activeUpstream: number;
      queuedUpstream: number;
      acquireUpstreamSlot(clientId: string): Promise<void>;
      releaseUpstreamSlot(clientId: string): void;
    };
    await Promise.all([
      pool.acquireUpstreamSlot('client-a'), pool.acquireUpstreamSlot('client-a'),
      pool.acquireUpstreamSlot('client-a'), pool.acquireUpstreamSlot('client-b'),
    ]);
    const pending = [
      ...Array.from({ length: 16 }, () => pool.acquireUpstreamSlot('client-a')),
      ...Array.from({ length: 8 }, () => pool.acquireUpstreamSlot('client-b')),
    ];
    const assertions = Promise.all(pending.map(request => expect(request).rejects.toThrow('queue wait timed out')));
    await expect(pool.acquireUpstreamSlot('client-c')).rejects.toThrow('capacity is temporarily full');
    await jest.advanceTimersByTimeAsync(8_000);
    await assertions;
    expect(pool.queuedUpstream).toBe(0);
    const newRequest = pool.acquireUpstreamSlot('client-c');
    pool.releaseUpstreamSlot('client-b');
    await newRequest;
    for (const clientId of ['client-a', 'client-a', 'client-a', 'client-c']) {
      pool.releaseUpstreamSlot(clientId);
    }
    expect(pool.activeUpstream).toBe(0);
  });

  it('rejects per-client and global queue overload, then recovers after capacity drains', async () => {
    const service = new DwdForecastTileService();
    const pool = service as unknown as {
      activeUpstream: number;
      queuedUpstream: number;
      acquireUpstreamSlot(clientId: string): Promise<void>;
      releaseUpstreamSlot(clientId: string): void;
    };
    await Promise.all([
      pool.acquireUpstreamSlot('client-a'), pool.acquireUpstreamSlot('client-a'),
      pool.acquireUpstreamSlot('client-a'), pool.acquireUpstreamSlot('client-b'),
    ]);
    const queuedA = Array.from({ length: 16 }, () => pool.acquireUpstreamSlot('client-a'));
    const queuedB = Array.from({ length: 8 }, () => pool.acquireUpstreamSlot('client-b'));
    await expect(pool.acquireUpstreamSlot('client-a')).rejects.toThrow('capacity is temporarily full');
    await expect(pool.acquireUpstreamSlot('client-b')).rejects.toThrow('capacity is temporarily full');
    expect(pool.activeUpstream).toBe(4);
    expect(pool.queuedUpstream).toBe(24);

    const releaseWhenGranted = (clientId: string, requests: Promise<void>[]) =>
      Promise.all(requests.map(request => request.then(() => pool.releaseUpstreamSlot(clientId))));
    pool.releaseUpstreamSlot('client-a'); pool.releaseUpstreamSlot('client-a');
    pool.releaseUpstreamSlot('client-a'); pool.releaseUpstreamSlot('client-b');
    await Promise.all([releaseWhenGranted('client-a', queuedA), releaseWhenGranted('client-b', queuedB)]);
    expect(pool.activeUpstream).toBe(0);
    expect(pool.queuedUpstream).toBe(0);
    await expect(pool.acquireUpstreamSlot('client-a')).resolves.toBeUndefined();
    pool.releaseUpstreamSlot('client-a');
  });
});
