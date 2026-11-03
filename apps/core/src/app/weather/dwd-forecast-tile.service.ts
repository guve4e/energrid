import {
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  decodeDwdGeoTiff,
  GeographicBounds,
  MalformedForecastRasterError,
  PALETTE_VERSION,
  renderPrecipitationTile,
  xyzTileBounds,
} from './precipitation-tile-renderer';

const COVERAGE_ID = 'dwd__Icon-eu_reg00625_fd_sl_TOTPREC01H';
const WMS_LAYER = 'Icon-eu_reg00625_fd_sl_TOTPREC01H';
const WCS_ENDPOINT = 'https://maps.dwd.de/geoserver/ows';
const WMS_CAPABILITIES_URL = 'https://maps.dwd.de/geoserver/dwd/Icon-eu_reg00625_fd_sl_TOTPREC01H/wms?service=WMS&version=1.3.0&request=GetCapabilities';
const WCS_ENVELOPE: GeographicBounds = { west: -23.53125, south: 29.46875, east: 62.53125, north: 70.53125 };
const UPSTREAM_TIMEOUT_MS = 12_000;
const NO_DATA_RETRIES = 2;
const MAX_UPSTREAM_BYTES = 3 * 1024 * 1024;
const MAX_PARALLEL_UPSTREAM = 4;
const MAX_QUEUED_UPSTREAM = 24;
const MAX_PARALLEL_UPSTREAM_PER_CLIENT = 3;
const MAX_QUEUED_UPSTREAM_PER_CLIENT = 16;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const DWD_GRID_STEP = 0.0625;

function snapCropToGrid(bounds: GeographicBounds): GeographicBounds {
  const lower = (value: number, origin: number) => origin + (Math.floor((value - origin) / DWD_GRID_STEP) - 1) * DWD_GRID_STEP;
  const upper = (value: number, origin: number) => origin + (Math.ceil((value - origin) / DWD_GRID_STEP) + 1) * DWD_GRID_STEP;
  return {
    west: Math.max(WCS_ENVELOPE.west, lower(bounds.west, WCS_ENVELOPE.west)),
    east: Math.min(WCS_ENVELOPE.east, upper(bounds.east, WCS_ENVELOPE.west)),
    south: Math.max(WCS_ENVELOPE.south, lower(bounds.south, WCS_ENVELOPE.south)),
    north: Math.min(WCS_ENVELOPE.north, upper(bounds.north, WCS_ENVELOPE.south)),
  };
}

type CachedTile = { image: Buffer; bytes: number };

function toUtcIso(compact: string) {
  if (!/^\d{8}T\d{6}Z$/.test(compact)) throw new RangeError('Forecast timestamps must be explicit UTC values');
  const iso = compact.slice(0, 4) + '-' + compact.slice(4, 6) + '-' + compact.slice(6, 8) + 'T' +
    compact.slice(9, 11) + ':' + compact.slice(11, 13) + ':' + compact.slice(13, 15) + 'Z';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString().replace(/[-:]/g, '').replace('.000', '') !== compact) {
    throw new RangeError('Invalid UTC forecast timestamp');
  }
  return iso;
}

function modelTimes(run: string, valid: string) {
  const referenceTime = toUtcIso(run);
  const validTime = toUtcIso(valid);
  const runMs = Date.parse(referenceTime);
  const validMs = Date.parse(validTime);
  if (validMs <= runMs || (validMs - runMs) % 3_600_000 !== 0 || validMs - runMs > 78 * 3_600_000) {
    throw new RangeError('Valid time is not an available hourly forecast lead for this run');
  }
  return { referenceTime, validTime };
}

function advertisedDimension(xml: string, name: string) {
  const dimension = [...xml.matchAll(/<Dimension\b([^>]*)>([\s\S]*?)<\/Dimension>/gi)]
    .find(([, attributes]) => new RegExp(`\\bname=["']${name}["']`, 'i').test(attributes));
  if (!dimension) throw new BadGatewayException('DWD forecast capabilities are missing the ' + name + ' dimension');
  const defaultValue = /\bdefault=["']([^"']+)["']/i.exec(dimension[1])?.[1];
  return { values: dimension[2].trim().split(',').map(value => value.trim()).filter(Boolean), defaultValue };
}

function normalizeCapabilityTime(value: string) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || !/Z$/.test(value)) return undefined;
  return new Date(milliseconds).toISOString().replace('.000Z', 'Z');
}

function assertPublishedTime(xml: string, referenceTime: string, validTime: string) {
  const times = advertisedDimension(xml, 'time');
  const references = advertisedDimension(xml, 'REFERENCE_TIME');
  const [start, end, step] = times.values[0]?.split('/') ?? [];
  const startMs = Date.parse(start); const endMs = Date.parse(end);
  const referenceMs = Date.parse(referenceTime); const validMs = Date.parse(validTime);
  const referenceValues = new Set([...references.values, references.defaultValue]
    .filter((value): value is string => Boolean(value))
    .map(normalizeCapabilityTime).filter((value): value is string => Boolean(value)));
  if (!referenceValues.has(referenceTime) || step !== 'PT1H' ||
      ![startMs, endMs, referenceMs, validMs].every(Number.isFinite) ||
      startMs % 3_600_000 !== 0 || endMs % 3_600_000 !== 0 ||
      validMs < startMs || validMs > endMs || (validMs - startMs) % 3_600_000 !== 0 ||
      validMs <= referenceMs || validMs - referenceMs > 78 * 3_600_000) {
    throw new NotFoundException('DWD does not advertise this forecast run and valid time');
  }
}

@Injectable()
export class DwdForecastTileService {
  private readonly tileCache = new Map<string, CachedTile>();
  private cacheBytes = 0;
  private readonly inFlight = new Map<string, Promise<Buffer>>();
  private activeUpstream = 0;
  private readonly activeUpstreamByClient = new Map<string, number>();
  private readonly upstreamQueue = new Map<string, Array<() => void>>();
  private readonly upstreamQueueOrder: string[] = [];
  private queuedUpstream = 0;
  private metadataPromise?: Promise<string>;
  private metadataExpiry = 0;
  private capabilitiesPromise?: Promise<string>;
  private capabilitiesExpiry = 0;

  async capabilities(clientId = 'internal') {
    if (this.capabilitiesPromise && Date.now() < this.capabilitiesExpiry) return this.capabilitiesPromise;
    const requestCurrent = async (attempt = 0): Promise<string> => {
      const capabilitiesUrl = new URL(WMS_CAPABILITIES_URL);
      capabilitiesUrl.searchParams.set('probe', Date.now() + '-' + attempt);
      const { contentType, body } = await this.fetchBounded(capabilitiesUrl.toString(), clientId);
      const xml = body.toString('utf8');
      if (!contentType.includes('xml') || xml.length > 256_000 || /<ows:Exception\b/.test(xml) ||
          !xml.includes(WMS_LAYER) || !/name="time"/.test(xml) || !/name="REFERENCE_TIME"/.test(xml)) {
        throw new BadGatewayException('DWD forecast capabilities are missing valid layer times');
      }
      const reference = /<Dimension\b[^>]*name="REFERENCE_TIME"[^>]*default="([^"]+)"/.exec(xml)?.[1];
      const referenceMs = reference ? Date.parse(reference) : NaN;
      const age = Date.now() - referenceMs;
      if (!Number.isFinite(referenceMs) || age < 0 || age > 18 * 60 * 60 * 1000) {
        if (attempt < 2) return requestCurrent(attempt + 1);
        throw new BadGatewayException('DWD forecast capabilities are stale or unavailable');
      }
      return xml;
    };
    const pending = requestCurrent().catch(error => {
      if (this.capabilitiesPromise === pending) {
        this.capabilitiesPromise = undefined;
        this.capabilitiesExpiry = 0;
      }
      throw error;
    });
    this.capabilitiesPromise = pending;
    this.capabilitiesExpiry = Date.now() + 5 * 60 * 1000;
    return pending;
  }

  async tile(run: string, valid: string, z: number, x: number, y: number, clientId = 'internal'): Promise<Buffer> {
    let times: ReturnType<typeof modelTimes>;
    let bounds: GeographicBounds;
    try {
      times = modelTimes(run, valid);
      bounds = xyzTileBounds(z, x, y);
    } catch (error) {
      throw new RangeError(error instanceof Error ? error.message : 'Invalid tile request');
    }

    const key = [COVERAGE_ID, run, valid, z, x, y, PALETTE_VERSION].join(':');
    const cached = this.tileCache.get(key);
    if (cached) {
      this.tileCache.delete(key);
      this.tileCache.set(key, cached);
      return cached.image;
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const task = this.capabilities(clientId).then(xml => {
      assertPublishedTime(xml, times.referenceTime, times.validTime);
      return this.createTile(times, bounds, z, x, y, clientId);
    }).then(image => {
      this.insertCache(key, image);
      return image;
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  private async createTile(
    times: { referenceTime: string; validTime: string },
    bounds: GeographicBounds,
    z: number,
    x: number,
    y: number,
    clientId: string,
  ) {
    const clipped = {
      west: Math.max(bounds.west, WCS_ENVELOPE.west),
      east: Math.min(bounds.east, WCS_ENVELOPE.east),
      south: Math.max(bounds.south, WCS_ENVELOPE.south),
      north: Math.min(bounds.north, WCS_ENVELOPE.north),
    };
    if (clipped.west >= clipped.east || clipped.south >= clipped.north) {
      return renderPrecipitationTile(undefined, bounds, x, y, z);
    }

    await this.ensureCoverageMetadata(clientId);
    const crop = snapCropToGrid(clipped);
    const params = new URLSearchParams();
      params.set('service', 'WCS');
      params.set('version', '2.0.1');
      params.set('request', 'GetCoverage');
      params.set('coverageId', COVERAGE_ID);
      params.set('format', 'image/tiff');
      params.append('subset', 'Lat(' + crop.south.toFixed(8) + ',' + crop.north.toFixed(8) + ')');
      params.append('subset', 'Long(' + crop.west.toFixed(8) + ',' + crop.east.toFixed(8) + ')');
      params.append('subset', 'time("' + times.validTime + '")');
      params.append('subset', 'REFERENCE_TIME("' + times.referenceTime + '")');
    const response = await this.fetchCoverageWithNoDataRetry(WCS_ENDPOINT + '?' + params.toString(), clientId);
    if (!response.contentType.includes('image/tiff') || !response.body.subarray(0, 2).equals(Buffer.from('MM')) &&
        !response.body.subarray(0, 2).equals(Buffer.from('II'))) {
      throw new BadGatewayException('DWD returned an unexpected forecast image format');
    }
    let grid;
    try {
      grid = decodeDwdGeoTiff(response.body);
    } catch (error) {
      if (error instanceof MalformedForecastRasterError) throw new BadGatewayException(error.message);
      throw error;
    }
    const rasterBounds = {
      west: grid.originLongitude - grid.longitudeStep / 2,
      east: grid.originLongitude + (grid.width - 0.5) * grid.longitudeStep,
      north: grid.originLatitude - grid.latitudeStep / 2,
      south: grid.originLatitude + (grid.height - 0.5) * grid.latitudeStep,
    };
    if (rasterBounds.east <= clipped.west || rasterBounds.west >= clipped.east ||
        rasterBounds.north <= clipped.south || rasterBounds.south >= clipped.north) {
      throw new BadGatewayException('DWD raster bounds do not intersect the requested tile crop');
    }
    return renderPrecipitationTile(grid, bounds, x, y, z);
  }

  private async fetchCoverageWithNoDataRetry(url: string, clientId: string) {
    for (let attempt = 0; attempt <= NO_DATA_RETRIES; attempt++) {
      const response = await this.fetchBounded(url, clientId);
      if (!response.contentType.includes('xml') && response.body.subarray(0, 1).toString() !== '<') return response;

      const message = response.body.toString('utf8').slice(0, 4000);
      if (!/No data available/i.test(message)) {
        throw new BadGatewayException('DWD returned a WCS exception instead of forecast imagery');
      }
      if (attempt === NO_DATA_RETRIES) {
        // DWD can return alternating TIFF and no-data responses for identical
        // requests. Do not turn a transient upstream miss into an immutable tile.
        throw new ServiceUnavailableException('DWD forecast coverage is temporarily unavailable');
      }
    }
    throw new ServiceUnavailableException('DWD forecast coverage is temporarily unavailable');
  }

  private async ensureCoverageMetadata(clientId: string) {
    if (this.metadataPromise && Date.now() < this.metadataExpiry) return this.metadataPromise;
    const pending = this.fetchBounded(WCS_ENDPOINT + '?service=WCS&version=2.0.1&request=DescribeCoverage&coverageId=' + COVERAGE_ID, clientId)
      .then(({ contentType, body }) => {
        const xml = body.toString('utf8');
        if (!contentType.includes('xml') || xml.length > 256_000 || /<ows:Exception\b/.test(xml) ||
            !xml.includes('<wcs:CoverageId>' + COVERAGE_ID + '</wcs:CoverageId>') ||
            !/srsName="[^"]*EPSG\/0\/4326"/.test(xml) ||
            !/<(?:\w+:)?uom\s+code="kg\/m²"\s*\/>/.test(xml) ||
            !/<(?:\w+:)?nativeFormat>image\/tiff<\/(?:\w+:)?nativeFormat>/.test(xml) ||
            !/offsetVector[^>]*>[^<]*-?0\.0625/.test(xml)) {
          throw new BadGatewayException('DWD coverage metadata no longer matches the expected grid and units');
        }
        return xml;
      }).catch(error => {
        if (this.metadataPromise === pending) {
          this.metadataPromise = undefined;
          this.metadataExpiry = 0;
        }
        throw error;
      });
    this.metadataPromise = pending;
    this.metadataExpiry = Date.now() + 6 * 60 * 60 * 1000;
    return pending;
  }

  private async fetchBounded(url: string, clientId = 'internal') {
    await this.acquireUpstreamSlot(clientId);
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), redirect: 'error',
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      });
      if (!response.ok) throw new BadGatewayException('DWD forecast request failed with status ' + response.status);
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_BYTES) {
        throw new BadGatewayException('DWD response exceeded the configured size limit');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new BadGatewayException('DWD returned an empty response');
      const chunks: Buffer[] = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > MAX_UPSTREAM_BYTES) {
          await reader.cancel();
          throw new BadGatewayException('DWD response exceeded the configured size limit');
        }
        chunks.push(Buffer.from(value));
      }
      return { contentType, body: Buffer.concat(chunks, bytes) };
    } catch (error) {
      if (error instanceof BadGatewayException || error instanceof NotFoundException) throw error;
      if (error instanceof Error && error.name === 'TimeoutError') throw new GatewayTimeoutException('DWD forecast request timed out');
      if (error instanceof Error && error.name === 'AbortError') throw new GatewayTimeoutException('DWD forecast request was aborted');
      throw new BadGatewayException('DWD forecast request failed');
    } finally {
      this.releaseUpstreamSlot(clientId);
    }
  }

  private async acquireUpstreamSlot(clientId: string) {
    if (this.activeUpstream < MAX_PARALLEL_UPSTREAM && this.upstreamQueueOrder.length === 0 &&
        this.activeForClient(clientId) < MAX_PARALLEL_UPSTREAM_PER_CLIENT) {
      this.grantUpstreamSlot(clientId);
      return;
    }
    const clientQueue = this.upstreamQueue.get(clientId);
    if (this.queuedUpstream >= MAX_QUEUED_UPSTREAM ||
        (clientQueue?.length ?? 0) >= MAX_QUEUED_UPSTREAM_PER_CLIENT) {
      throw new ServiceUnavailableException('DWD forecast tile capacity is temporarily full');
    }
    await new Promise<void>(resolve => {
      if (!clientQueue) {
        this.upstreamQueue.set(clientId, [resolve]);
        this.upstreamQueueOrder.push(clientId);
      } else {
        clientQueue.push(resolve);
      }
      this.queuedUpstream++;
      this.dispatchQueuedUpstream();
    });
  }

  private releaseUpstreamSlot(clientId: string) {
    this.activeUpstream--;
    const activeForClient = this.activeForClient(clientId) - 1;
    if (activeForClient > 0) this.activeUpstreamByClient.set(clientId, activeForClient);
    else this.activeUpstreamByClient.delete(clientId);
    this.dispatchQueuedUpstream();
  }

  private activeForClient(clientId: string) {
    return this.activeUpstreamByClient.get(clientId) ?? 0;
  }

  private grantUpstreamSlot(clientId: string) {
    this.activeUpstream++;
    this.activeUpstreamByClient.set(clientId, this.activeForClient(clientId) + 1);
  }

  private dispatchQueuedUpstream() {
    while (this.activeUpstream < MAX_PARALLEL_UPSTREAM && this.upstreamQueueOrder.length > 0) {
      const eligibleIndex = this.upstreamQueueOrder.findIndex(clientId =>
        this.activeForClient(clientId) < MAX_PARALLEL_UPSTREAM_PER_CLIENT);
      if (eligibleIndex < 0) return;
      const [clientId] = this.upstreamQueueOrder.splice(eligibleIndex, 1);
      const clientQueue = this.upstreamQueue.get(clientId);
      const next = clientQueue?.shift();
      if (!next || !clientQueue) continue;
      this.queuedUpstream--;
      if (clientQueue.length > 0) this.upstreamQueueOrder.push(clientId);
      else this.upstreamQueue.delete(clientId);
      this.grantUpstreamSlot(clientId);
      next();
    }
  }

  private insertCache(key: string, image: Buffer) {
    if (image.length > MAX_CACHE_BYTES) return;
    while (this.cacheBytes + image.length > MAX_CACHE_BYTES) {
      const oldest = this.tileCache.keys().next().value as string | undefined;
      if (!oldest) break;
      const oldestTile = this.tileCache.get(oldest);
      if (!oldestTile) { this.tileCache.delete(oldest); continue; }
      this.cacheBytes -= oldestTile.bytes;
      this.tileCache.delete(oldest);
    }
    this.tileCache.set(key, { image, bytes: image.length });
    this.cacheBytes += image.length;
  }
}

export { modelTimes, toUtcIso };
