import { deflateSync } from 'node:zlib';

export const PALETTE_VERSION = 'precip-v6';
export const TILE_SIZE = 256;

export interface RasterGrid {
  width: number;
  height: number;
  values: Float64Array;
  originLongitude: number;
  originLatitude: number;
  longitudeStep: number;
  latitudeStep: number;
  noDataValue?: number;
}

export interface GeographicBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export class MalformedForecastRasterError extends Error {}

type TiffTag = { type: number; count: number; value: number; valueOffset: number };

const TIFF_TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8 };

function assertRange(buffer: Buffer, offset: number, length: number) {
  if (offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new MalformedForecastRasterError('Truncated GeoTIFF response');
  }
}

function parseTags(buffer: Buffer) {
  if (buffer.length < 8 || !['II', 'MM'].includes(buffer.toString('ascii', 0, 2))) {
    throw new MalformedForecastRasterError('Upstream response is not a TIFF image');
  }
  const littleEndian = buffer.toString('ascii', 0, 2) === 'II';
  const u16 = (offset: number) => littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  const u32 = (offset: number) => littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  if (u16(2) !== 42) throw new MalformedForecastRasterError('Unsupported TIFF variant');
  const ifdOffset = u32(4);
  assertRange(buffer, ifdOffset, 2);
  const count = u16(ifdOffset);
  if (count > 256) throw new MalformedForecastRasterError('GeoTIFF has too many metadata fields');
  assertRange(buffer, ifdOffset + 2, count * 12);
  const tags = new Map<number, TiffTag>();
  for (let index = 0; index < count; index++) {
    const offset = ifdOffset + 2 + index * 12;
    const tag = u16(offset);
    const type = u16(offset + 2);
    const items = u32(offset + 4);
    const value = u32(offset + 8);
    const itemSize = TIFF_TYPE_SIZE[type];
    if (!itemSize || items < 1 || items > 100_000) {
      throw new MalformedForecastRasterError('Invalid GeoTIFF field');
    }
    const valueOffset = items * itemSize <= 4 ? offset + 8 : value;
    assertRange(buffer, valueOffset, items * itemSize);
    tags.set(tag, { type, count: items, value, valueOffset });
  }
  return { tags, littleEndian };
}

function tagNumbers(buffer: Buffer, tags: Map<number, TiffTag>, tagId: number, littleEndian: boolean) {
  const tag = tags.get(tagId);
  if (!tag) return undefined;
  const result: number[] = [];
  for (let index = 0; index < tag.count; index++) {
    const offset = tag.valueOffset + index * TIFF_TYPE_SIZE[tag.type];
    if (tag.type === 3) result.push(littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset));
    else if (tag.type === 4) result.push(littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
    else if (tag.type === 12) result.push(littleEndian ? buffer.readDoubleLE(offset) : buffer.readDoubleBE(offset));
    else throw new MalformedForecastRasterError('Unsupported GeoTIFF numeric field');
  }
  return result;
}

function tagScalar(buffer: Buffer, tags: Map<number, TiffTag>, id: number, littleEndian: boolean) {
  const values = tagNumbers(buffer, tags, id, littleEndian);
  if (!values || values.length !== 1) throw new MalformedForecastRasterError('Missing GeoTIFF dimensions');
  return values[0];
}

export function decodeDwdGeoTiff(buffer: Buffer): RasterGrid {
  const { tags, littleEndian } = parseTags(buffer);
  const width = tagScalar(buffer, tags, 256, littleEndian);
  const height = tagScalar(buffer, tags, 257, littleEndian);
  const bits = tagNumbers(buffer, tags, 258, littleEndian)?.[0];
  const compression = tagNumbers(buffer, tags, 259, littleEndian)?.[0];
  const samples = tagNumbers(buffer, tags, 277, littleEndian)?.[0] ?? 1;
  const sampleFormat = tagNumbers(buffer, tags, 339, littleEndian)?.[0];
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 100_000 ||
      bits !== 64 || compression !== 1 || samples !== 1 || sampleFormat !== 3) {
    throw new MalformedForecastRasterError('Unexpected DWD raster dimensions or sample format');
  }

  const geoKeys = tagNumbers(buffer, tags, 34735, littleEndian);
  if (!geoKeys || geoKeys.length < 4 || geoKeys[0] !== 1) {
    throw new MalformedForecastRasterError('GeoTIFF CRS metadata is missing');
  }
  let modelType: number | undefined;
  let rasterType: number | undefined;
  let epsg: number | undefined;
  for (let index = 0; index < geoKeys[3]; index++) {
    const key = 4 + index * 4;
    if (key + 3 >= geoKeys.length) throw new MalformedForecastRasterError('Invalid GeoTIFF CRS metadata');
    if (geoKeys[key] === 1024) modelType = geoKeys[key + 3];
    if (geoKeys[key] === 1025) rasterType = geoKeys[key + 3];
    if (geoKeys[key] === 2048) epsg = geoKeys[key + 3];
  }
  if (modelType !== 2 || rasterType !== 1 || epsg !== 4326) {
    throw new MalformedForecastRasterError('DWD raster must be PixelIsArea in EPSG:4326');
  }

  const matrix = tagNumbers(buffer, tags, 34264, littleEndian);
  if (!matrix || matrix.length !== 16 || matrix[1] !== 0 || matrix[2] !== 0 || matrix[4] !== 0 ||
      matrix[6] !== 0 || matrix[8] !== 0 || matrix[9] !== 0 || matrix[10] !== 0 || matrix[12] !== 0 ||
      matrix[13] !== 0 || matrix[14] !== 0 || matrix[15] !== 1) {
    throw new MalformedForecastRasterError('Unsupported or malformed GeoTIFF geotransform');
  }
  const longitudeStep = matrix[0];
  const latitudeStep = matrix[5];
  const originLongitude = matrix[3];
  const originLatitude = matrix[7];
  if (!(longitudeStep > 0) || !(latitudeStep < 0) || ![originLongitude, originLatitude].every(Number.isFinite) ||
      originLongitude < -23.6 || originLongitude > 62.6 || originLatitude < 29.4 || originLatitude > 70.6 ||
      Math.abs(longitudeStep - 0.0625) > 1e-8 || Math.abs(latitudeStep + 0.0625) > 1e-8) {
    throw new MalformedForecastRasterError('Unexpected DWD geographic grid');
  }

  const values = new Float64Array(width * height);
  const tileOffsets = tagNumbers(buffer, tags, 324, littleEndian);
  const tileByteCounts = tagNumbers(buffer, tags, 325, littleEndian);
  if (tileOffsets && tileByteCounts) {
    const tileWidth = tagScalar(buffer, tags, 322, littleEndian);
    const tileHeight = tagScalar(buffer, tags, 323, littleEndian);
    const across = Math.ceil(width / tileWidth);
    const down = Math.ceil(height / tileHeight);
    if (tileOffsets.length !== across * down || tileByteCounts.length !== tileOffsets.length) {
      throw new MalformedForecastRasterError('Invalid GeoTIFF tile table');
    }
    for (let tile = 0; tile < tileOffsets.length; tile++) {
      const x0 = (tile % across) * tileWidth;
      const y0 = Math.floor(tile / across) * tileHeight;
      const bytes = tileByteCounts[tile];
      assertRange(buffer, tileOffsets[tile], bytes);
      const tileValues = Math.floor(bytes / 8);
      if (bytes % 8 || tileValues !== tileWidth * tileHeight) {
        throw new MalformedForecastRasterError('Unexpected GeoTIFF tile byte count');
      }
      for (let y = 0; y < tileHeight && y0 + y < height; y++) {
        for (let x = 0; x < tileWidth && x0 + x < width; x++) {
          const from = tileOffsets[tile] + (y * tileWidth + x) * 8;
          const value = littleEndian ? buffer.readDoubleLE(from) : buffer.readDoubleBE(from);
          values[(y0 + y) * width + x0 + x] = value;
        }
      }
    }
  } else {
    const offsets = tagNumbers(buffer, tags, 273, littleEndian);
    const byteCounts = tagNumbers(buffer, tags, 279, littleEndian);
    const rowsPerStrip = tagNumbers(buffer, tags, 278, littleEndian)?.[0] ?? height;
    if (!offsets || !byteCounts || offsets.length !== byteCounts.length || offsets.length !== Math.ceil(height / rowsPerStrip)) {
      throw new MalformedForecastRasterError('Unsupported GeoTIFF storage layout');
    }
    let rowStart = 0;
    offsets.forEach((offset, index) => {
      assertRange(buffer, offset, byteCounts[index]);
      const rows = Math.min(rowsPerStrip, height - rowStart);
      if (byteCounts[index] !== rows * width * 8) throw new MalformedForecastRasterError('Invalid GeoTIFF strip size');
      for (let pixel = 0; pixel < rows * width; pixel++) {
        const at = offset + pixel * 8;
        values[rowStart * width + pixel] = littleEndian ? buffer.readDoubleLE(at) : buffer.readDoubleBE(at);
      }
      rowStart += rows;
    });
  }

  let noDataValue: number | undefined;
  const noDataTag = tags.get(42113);
  if (noDataTag) {
    const text = buffer.toString('ascii', noDataTag.valueOffset, noDataTag.valueOffset + noDataTag.count).replace(/\0+$/, '');
    const parsed = Number(text);
    if (text !== 'nan' && !Number.isFinite(parsed)) throw new MalformedForecastRasterError('Invalid GeoTIFF no-data metadata');
    noDataValue = text === 'nan' ? Number.NaN : parsed;
  }
  // GeoTIFF ModelTransformation identifies the upper-left pixel edge for PixelIsArea.
  // Keep RasterGrid origins at sample centers so all resampling uses one convention.
  return {
    width, height, values,
    originLongitude: originLongitude + longitudeStep / 2,
    originLatitude: originLatitude + latitudeStep / 2,
    longitudeStep, latitudeStep, noDataValue,
  };
}

export function xyzTileBounds(z: number, x: number, y: number): GeographicBounds {
  if (!Number.isInteger(z) || z < 5 || z > 12 || !Number.isInteger(x) || !Number.isInteger(y) ||
      x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) throw new RangeError('Invalid XYZ tile coordinates');
  const n = 2 ** z;
  const lon = (tileX: number) => tileX / n * 360 - 180;
  const lat = (tileY: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / n))) * 180 / Math.PI;
  return { west: lon(x), east: lon(x + 1), north: lat(y), south: lat(y + 1) };
}

function precipitationColor(value: number): [number, number, number, number] {
  const stops: Array<[number, [number, number, number], number]> = [
    [0.01, [28, 125, 255], 80], [0.1, [24, 198, 255], 92], [1, [34, 218, 164], 112],
    [5, [255, 218, 54], 145], [20, [250, 66, 42], 180],
  ];
  const amount = Math.max(value, 0.01);
  const point = Math.log1p(amount);
  for (let index = 0; index < stops.length - 1; index++) {
    const [left, a] = stops[index];
    const [right, b] = stops[index + 1];
    if (amount <= right) {
      const ratio = (point - Math.log1p(left)) / (Math.log1p(right) - Math.log1p(left));
      const alpha = stops[index][2] + ratio * (stops[index + 1][2] - stops[index][2]);
      return [0, 1, 2].map(channel => Math.round(a[channel] + ratio * (b[channel] - a[channel])))
        .concat(Math.round(alpha)) as [number, number, number, number];
    }
  }
  return [250, 66, 42, 180];
}

const CRC_TABLE = new Uint32Array(256).map((_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function pngChunk(type: string, data: Buffer) {
  const typeBuffer = Buffer.from(type);
  const checksumBuffer = Buffer.allocUnsafe(4);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([typeBuffer, data])) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  checksumBuffer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  const lengthBuffer = Buffer.allocUnsafe(4);
  lengthBuffer.writeUInt32BE(data.length);
  return Buffer.concat([lengthBuffer, typeBuffer, data, checksumBuffer]);
}

function isNoData(value: number, marker?: number) {
  return !Number.isFinite(value) || value < 0 || marker !== undefined && (Number.isNaN(marker) ? Number.isNaN(value) : value === marker);
}

function noDataColor(x: number, y: number): [number, number, number, number] {
  return ((x + y) >> 3) & 1 ? [180, 54, 194, 38] : [90, 40, 120, 16];
}

function interpolatedValue(grid: RasterGrid, longitude: number, latitude: number): number | undefined {
  const column = (longitude - grid.originLongitude) / grid.longitudeStep;
  const row = (latitude - grid.originLatitude) / grid.latitudeStep;
  if (column < -0.5 || row < -0.5 || column > grid.width - 0.5 || row > grid.height - 0.5) return undefined;
  const safeColumn = Math.max(0, Math.min(grid.width - 1, column));
  const safeRow = Math.max(0, Math.min(grid.height - 1, row));
  const left = Math.floor(safeColumn); const top = Math.floor(safeRow);
  const right = Math.min(left + 1, grid.width - 1); const bottom = Math.min(top + 1, grid.height - 1);
  const horizontal = safeColumn - left; const vertical = safeRow - top;
  const samples: Array<[number, number]> = [
    [grid.values[top * grid.width + left], (1 - horizontal) * (1 - vertical)],
    [grid.values[top * grid.width + right], horizontal * (1 - vertical)],
    [grid.values[bottom * grid.width + left], (1 - horizontal) * vertical],
    [grid.values[bottom * grid.width + right], horizontal * vertical],
  ];
  if (samples.some(([sample, weight]) => weight > 0 && isNoData(sample, grid.noDataValue))) return undefined;
  const nearestColumn = Math.round(safeColumn);
  const nearestRow = Math.round(safeRow);
  if (grid.values[nearestRow * grid.width + nearestColumn] === 0) return 0;
  let value = 0;
  let positiveWeight = 0;
  for (const [sample, weight] of samples) {
    if (weight === 0) continue;
    // Preserve the model's wet/dry cells: interpolation must not create rain in a
    // source cell that reports exact zero.
    if (sample === 0) continue;
    value += sample * weight;
    positiveWeight += weight;
  }
  return positiveWeight === 0 ? 0 : value / positiveWeight;
}

export function renderPrecipitationTile(grid: RasterGrid | undefined, bounds: GeographicBounds, x: number, y: number, z: number) {
  const rows: Buffer[] = [];
  const globalX = x * TILE_SIZE;
  const globalY = y * TILE_SIZE;
  for (let py = 0; py < TILE_SIZE; py++) {
    const row = Buffer.allocUnsafe(1 + TILE_SIZE * 4);
    row[0] = 0;
    const worldY = (globalY + py + 0.5) / (TILE_SIZE * 2 ** z);
    const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY))) * 180 / Math.PI;
    for (let px = 0; px < TILE_SIZE; px++) {
      const worldX = (globalX + px + 0.5) / (TILE_SIZE * 2 ** z);
      const longitude = worldX * 360 - 180;
      let color: [number, number, number, number];
      if (latitude < bounds.south || latitude > bounds.north || longitude < bounds.west || longitude > bounds.east || !grid) {
        color = noDataColor(globalX + px, globalY + py);
      } else {
        const sample = interpolatedValue(grid, longitude, latitude);
        color = sample === undefined
          ? noDataColor(globalX + px, globalY + py)
          : sample === 0 ? [0, 0, 0, 0] : precipitationColor(sample);
      }
      const offset = 1 + px * 4;
      row[offset] = color[0]; row[offset + 1] = color[1]; row[offset + 2] = color[2]; row[offset + 3] = color[3];
    }
    rows.push(row);
  }
  const header = Buffer.allocUnsafe(13);
  header.writeUInt32BE(TILE_SIZE, 0); header.writeUInt32BE(TILE_SIZE, 4);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
