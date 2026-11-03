import { NotFoundException } from '@nestjs/common';
import { DwdForecastTileController } from './dwd-forecast-tile.controller';
import { DwdForecastTileService } from './dwd-forecast-tile.service';
import { PALETTE_VERSION } from './precipitation-tile-renderer';

function responseStub() {
  const headers = new Map<string, string>();
  const response = {
    headers,
    body: undefined as Buffer | string | undefined,
    code: 0,
    setHeader(name: string, value: string) { headers.set(name, value); },
    status(code: number) { response.code = code; return response; },
    send(body: Buffer | string) { response.body = body; return response; },
  };
  return response;
}

describe('DWD forecast tile HTTP response contract', () => {
  it('marks failed tile responses no-store so an intermediary cannot retain an error as an immutable PNG', async () => {
    const tiles = { tile: jest.fn().mockRejectedValue(new NotFoundException('unsupported forecast time')) };
    const controller = new DwdForecastTileController(tiles as unknown as DwdForecastTileService);
    const response = responseStub();
    await expect(controller.getTile('20261101T120000Z', '20261101T200000Z', 8, 144, 93,
      PALETTE_VERSION, { socket: { remoteAddress: '127.0.0.1' } }, response)).rejects.toThrow(NotFoundException);
    expect(tiles.tile).toHaveBeenCalledWith('20261101T120000Z', '20261101T200000Z', 8, 144, 93, '127.0.0.1');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.body).toBeUndefined();
  });

  it('caches only a successful PNG at its immutable timestamp-and-version URL', async () => {
    const png = Buffer.from([137, 80, 78, 71]);
    const tiles = { tile: jest.fn().mockResolvedValue(png) };
    const controller = new DwdForecastTileController(tiles as unknown as DwdForecastTileService);
    const response = responseStub();
    await controller.getTile('20261101T120000Z', '20261101T200000Z', 8, 144, 93,
      PALETTE_VERSION, { socket: { remoteAddress: '127.0.0.1' } }, response);
    expect(response.code).toBe(200);
    expect(response.body).toBe(png);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400, immutable');
  });
});
