import { Injectable } from '@nestjs/common';
import {
  parseFirmwareDiagnosticSample,
  type FirmwareDiagnosticFailureReason,
  type FirmwareDiagnosticSample,
} from '../../../device-firmware-diagnostics';

export class FirmwareDiagnosticsCollectionError extends Error {
  constructor(readonly reason: FirmwareDiagnosticFailureReason) {
    super(reason);
    this.name = 'FirmwareDiagnosticsCollectionError';
  }
}

/** Read-only bounded adapter for the Energrid ESP8266 diagnostics contract. */
@Injectable()
export class EnergridFirmwareDiagnosticsHttpAdapter {
  async collect(
    verifiedIdentityUrl: string,
    expectedPhysicalId: string,
    signal: AbortSignal,
  ): Promise<FirmwareDiagnosticSample> {
    let origin: string;
    try {
      const identityUrl = new URL(verifiedIdentityUrl);
      if (identityUrl.protocol !== 'http:' || identityUrl.username || identityUrl.password || identityUrl.hash) {
        throw new Error('invalid endpoint');
      }
      origin = identityUrl.origin;
    } catch {
      throw new FirmwareDiagnosticsCollectionError('endpoint_unverified');
    }

    let response: Response;
    try {
      response = await fetch(new URL('/api/v1/diagnostics', origin), {
        signal,
        redirect: 'manual',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new FirmwareDiagnosticsCollectionError('request_timeout');
      }
      throw new FirmwareDiagnosticsCollectionError('collector_error');
    }
    if (response.status >= 300 && response.status < 400) {
      throw new FirmwareDiagnosticsCollectionError('diagnostics_http_error');
    }
    if (!response.ok) throw new FirmwareDiagnosticsCollectionError('diagnostics_http_error');

    const payload = await readBoundedJson(response, 4 * 1024);
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const reportedId = (payload as Record<string, unknown>).deviceId;
      if (typeof reportedId === 'string' && reportedId.toLowerCase() !== expectedPhysicalId.toLowerCase()) {
        throw new FirmwareDiagnosticsCollectionError('identity_mismatch');
      }
    }
    const sample = parseFirmwareDiagnosticSample(payload, expectedPhysicalId);
    if (!sample) throw new FirmwareDiagnosticsCollectionError('response_invalid');
    return sample;
  }
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new FirmwareDiagnosticsCollectionError('response_invalid');
  }
  try {
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximumBytes) {
          await reader.cancel();
          throw new FirmwareDiagnosticsCollectionError('response_invalid');
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')) as unknown;
    }
    if (typeof response.text === 'function') {
      const body = await response.text();
      if (Buffer.byteLength(body, 'utf8') > maximumBytes) {
        throw new FirmwareDiagnosticsCollectionError('response_invalid');
      }
      return JSON.parse(body) as unknown;
    }
    const payload = await response.json();
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > maximumBytes) {
      throw new FirmwareDiagnosticsCollectionError('response_invalid');
    }
    return payload;
  } catch (error) {
    if (error instanceof FirmwareDiagnosticsCollectionError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new FirmwareDiagnosticsCollectionError('request_timeout');
    }
    throw new FirmwareDiagnosticsCollectionError('response_invalid');
  }
}
