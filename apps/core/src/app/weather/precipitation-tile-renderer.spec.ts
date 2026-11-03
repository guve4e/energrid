import { inflateSync } from 'node:zlib';
import {
  decodeDwdGeoTiff,
  MalformedForecastRasterError,
  renderPrecipitationTile,
  xyzTileBounds,
} from './precipitation-tile-renderer';

function pixelAt(image: Buffer, x: number, y: number) {
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset < image.length) {
    const length = image.readUInt32BE(offset);
    const kind = image.toString('ascii', offset + 4, offset + 8);
    if (kind === 'IDAT') idat.push(image.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const pixel = y * (1 + 256 * 4) + 1 + x * 4;
  return [...raw.subarray(pixel, pixel + 4)];
}
const sampleAtMiddle = (image: Buffer) => pixelAt(image, 128, 128);

function onePixelGeoTiff(value: number) {
  const tags: Array<[number, number, number, number]> = [
    [256, 3, 1, 1], [257, 3, 1, 1], [258, 3, 1, 64], [259, 3, 1, 1],
    [277, 3, 1, 1], [339, 3, 1, 3], [322, 3, 1, 1], [323, 3, 1, 1],
    [324, 4, 1, 344], [325, 4, 1, 8], [34264, 12, 16, 184], [34735, 3, 16, 312],
  ];
  const image = Buffer.alloc(352);
  image.write('MM', 0); image.writeUInt16BE(42, 2); image.writeUInt32BE(8, 4);
  image.writeUInt16BE(tags.length, 8);
  tags.forEach(([id, type, count, value], index) => {
    const at = 10 + index * 12;
    image.writeUInt16BE(id, at); image.writeUInt16BE(type, at + 2); image.writeUInt32BE(count, at + 4);
    if (type === 3 && count === 1) image.writeUInt16BE(value, at + 8);
    else image.writeUInt32BE(value, at + 8);
  });
  image.writeUInt32BE(0, 10 + tags.length * 12);
  [0.0625, 0, 0, 22.03125, 0, -0.0625, 0, 43.96875, 0, 0, 0, 0, 0, 0, 0, 1]
    .forEach((number, index) => image.writeDoubleBE(number, 184 + index * 8));
  [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]
    .forEach((number, index) => image.writeUInt16BE(number, 312 + index * 2));
  image.writeDoubleBE(value, 344);
  return image;
}

describe('DWD precipitation raster renderer', () => {
  it('decodes DWD GeoTIFF CRS, grid alignment, and hourly numeric units', () => {
    const grid = decodeDwdGeoTiff(onePixelGeoTiff(0.3154296875));
    expect([grid.width, grid.height]).toEqual([1, 1]);
    expect([grid.originLongitude, grid.originLatitude]).toEqual([22.0625, 43.9375]);
    expect([grid.longitudeStep, grid.latitudeStep]).toEqual([0.0625, -0.0625]);
    expect(grid.values[0]).toBe(0.3154296875);
  });

  it('rejects malformed WCS responses instead of treating them as zero rainfall', () => {
    expect(() => decodeDwdGeoTiff(Buffer.from('<ows:ExceptionReport/>')))
      .toThrow(MalformedForecastRasterError);
  });

  it('aligns PixelIsArea samples and does not interpolate rain into exact-zero cells', () => {
    const z = 8;
    const x = Math.floor((22.93 + 180) / 360 * 2 ** z);
    const y = Math.floor((1 - Math.asinh(Math.tan(43.87 * Math.PI / 180)) / Math.PI) / 2 * 2 ** z);
    const bounds = xyzTileBounds(z, x, y);
    const longitude = ((x * 256 + 128.5) / (256 * 2 ** z)) * 360 - 180;
    const worldY = (y * 256 + 128.5) / (256 * 2 ** z);
    const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY))) * 180 / Math.PI;
    const grid = {
      width: 2, height: 2, originLongitude: longitude - 0.03125, originLatitude: latitude + 0.03125,
      longitudeStep: 0.0625, latitudeStep: -0.0625,
      values: new Float64Array([0, 1, 0, 1]),
    };
    const interpolated = renderPrecipitationTile(grid, bounds, x, y, z);
    const halfMillimetre = renderPrecipitationTile({ ...grid, values: new Float64Array([0.5, 0.5, 0.5, 0.5]) }, bounds, x, y, z);
    const interpolatedPixel = sampleAtMiddle(interpolated);
    const expectedPixel = sampleAtMiddle(halfMillimetre);
    const zeroX = Math.round((((longitude - 0.03125 + 180) / 360) * 256 * 2 ** z) - x * 256 - 0.5);
    const zeroY = Math.round((((1 - Math.asinh(Math.tan((latitude + 0.03125) * Math.PI / 180)) / Math.PI) / 2) * 256 * 2 ** z) - y * 256 - 0.5);
    expect(interpolatedPixel[3]).toBeGreaterThan(0);
    expect(pixelAt(interpolated, zeroX, zeroY)[3]).toBe(0);
    expect(expectedPixel[3]).toBeGreaterThan(0);

    const exactZero = renderPrecipitationTile({ ...grid, values: new Float64Array([0, 0, 0, 0]) }, bounds, x, y, z);
    expect(sampleAtMiddle(exactZero)[3]).toBe(0);
  });

  it('does not interpolate through no-data and keeps it distinct from exact zero', () => {
    const z = 8;
    const x = Math.floor((22.93 + 180) / 360 * 2 ** z);
    const y = Math.floor((1 - Math.asinh(Math.tan(43.87 * Math.PI / 180)) / Math.PI) / 2 * 2 ** z);
    const bounds = xyzTileBounds(z, x, y);
    const longitude = ((x * 256 + 128.5) / (256 * 2 ** z)) * 360 - 180;
    const worldY = (y * 256 + 128.5) / (256 * 2 ** z);
    const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY))) * 180 / Math.PI;
    const grid = {
      width: 2, height: 2, originLongitude: longitude - 0.03125, originLatitude: latitude + 0.03125,
      longitudeStep: 0.0625, latitudeStep: -0.0625,
      values: new Float64Array([0.5, 0.5, 0.5, Number.NaN]),
    };
    const missing = sampleAtMiddle(renderPrecipitationTile(grid, bounds, x, y, z));
    const fullCoverage = sampleAtMiddle(renderPrecipitationTile({ ...grid, values: new Float64Array([0.5, 0.5, 0.5, 0.5]) }, bounds, x, y, z));
    const zeroWithGap = sampleAtMiddle(renderPrecipitationTile({ ...grid, values: new Float64Array([0, 0, 0, Number.NaN]) }, bounds, x, y, z));
    expect(missing[3]).toBeGreaterThan(0);
    expect(missing).not.toEqual(fullCoverage);
    expect(zeroWithGap[3]).toBeGreaterThan(0);
  });

  it('places Vidin inside its Web Mercator tile with transparent zero and visible light rain', () => {
    const z = 8;
    const x = Math.floor((22.93 + 180) / 360 * 2 ** z);
    const y = Math.floor((1 - Math.asinh(Math.tan(43.87 * Math.PI / 180)) / Math.PI) / 2 * 2 ** z);
    const bounds = xyzTileBounds(z, x, y);
    expect(bounds.west).toBeLessThan(22.93);
    expect(bounds.east).toBeGreaterThan(22.93);
    expect(bounds.south).toBeLessThan(43.87);
    expect(bounds.north).toBeGreaterThan(43.87);

    const middleLon = ((x + 128.5 / 256) / 2 ** z) * 360 - 180;
    const middleWorldY = (y + 128.5 / 256) / 2 ** z;
    const middleLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * middleWorldY))) * 180 / Math.PI;
    const grid = {
      width: 1, height: 1, originLongitude: middleLon, originLatitude: middleLat,
      longitudeStep: 0.0625, latitudeStep: -0.0625, values: new Float64Array([0.315]),
    };
    const rain = renderPrecipitationTile(grid, bounds, x, y, z);
    const zero = renderPrecipitationTile({ ...grid, values: new Float64Array([0]) }, bounds, x, y, z);
    const noData = renderPrecipitationTile({ ...grid, values: new Float64Array([Number.NaN]) }, bounds, x, y, z);
    expect(sampleAtMiddle(rain)[3]).toBeGreaterThan(0);
    expect(sampleAtMiddle(zero)[3]).toBe(0);
    expect(sampleAtMiddle(noData)[3]).toBeGreaterThan(0);
    expect(sampleAtMiddle(noData)).not.toEqual(sampleAtMiddle(zero));
  });

  it('renders a deterministic zero-to-extreme precipitation fixture with distinct no-data', () => {
    const z = 8; const x = 144; const y = 93;
    const bounds = xyzTileBounds(z, x, y);
    const originLongitude = bounds.west + 0.03;
    const originLatitude = bounds.north - 0.03;
    const values = [0, 0.315, 1, 5, 20, 100, 20, 20, Number.NaN];
    const grid = { width: values.length, height: 1, originLongitude, originLatitude,
      longitudeStep: 0.0625, latitudeStep: -0.0625, noDataValue: Number.NaN, values: new Float64Array(values) };
    const image = renderPrecipitationTile(grid, bounds, x, y, z);
    const sample = (index: number) => {
      const longitude = originLongitude + index * grid.longitudeStep;
      const latitude = originLatitude;
      const pixelX = Math.round((longitude + 180) / 360 * 256 * 2 ** z - x * 256 - 0.5);
      const worldY = (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2;
      const pixelY = Math.round(worldY * 256 * 2 ** z - y * 256 - 0.5);
      return pixelAt(image, pixelX, pixelY);
    };
    const pixels = values.map((_, index) => sample(index));
    expect(pixels[0][3]).toBe(0);
    expect(pixels[1][3]).toBeGreaterThan(0); // 0.315 mm/hour light-rain proof fixture
    expect(pixels[2][3]).toBeGreaterThan(pixels[1][3]);
    expect(pixels[3][3]).toBeGreaterThan(pixels[2][3]);
    expect(pixels[4][3]).toBeGreaterThan(pixels[3][3]);
    expect(pixels[5][3]).toBeGreaterThanOrEqual(pixels[4][3]);
    expect(pixels[6][3]).toBeGreaterThan(0);
    expect(pixels[6]).not.toEqual(pixels[0]);
    expect(pixels[6]).not.toEqual(pixels[1]);
  });

  it('samples a smooth global source grid consistently across adjacent XYZ tile edges', () => {
    const z = 8; const x = 144; const y = 93;
    const leftBounds = xyzTileBounds(z, x, y); const rightBounds = xyzTileBounds(z, x + 1, y);
    const grid = {
      width: 52, height: 28, originLongitude: leftBounds.west - 0.03125,
      originLatitude: leftBounds.north + 0.03125, longitudeStep: 0.0625, latitudeStep: -0.0625,
      values: new Float64Array(52 * 28),
    };
    for (let row = 0; row < grid.height; row++) {
      for (let column = 0; column < grid.width; column++) {
        grid.values[row * grid.width + column] = 1 + column * 0.02 + row * 0.01;
      }
    }
    const westTile = renderPrecipitationTile(grid, leftBounds, x, y, z);
    const eastTile = renderPrecipitationTile(grid, rightBounds, x + 1, y, z);
    const westEdge = pixelAt(westTile, 255, 128); const eastEdge = pixelAt(eastTile, 0, 128);
    expect(westEdge[3]).toBeGreaterThan(0);
    expect(eastEdge[3]).toBeGreaterThan(0);
    expect(Math.abs(westEdge[0] - eastEdge[0])).toBeLessThanOrEqual(2);
    expect(Math.abs(westEdge[1] - eastEdge[1])).toBeLessThanOrEqual(2);
    expect(Math.abs(westEdge[2] - eastEdge[2])).toBeLessThanOrEqual(2);
    expect(Math.abs(westEdge[3] - eastEdge[3])).toBeLessThanOrEqual(2);
  });
});
