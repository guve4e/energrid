import { Inject, Injectable, Optional } from '@nestjs/common';
import { request as httpRequest } from 'node:http';

export interface EnergridHttpIdentity {
  id: string;
  model: string;
  firmwareVersion: string;
  capabilities: string[];
}

export interface EnergridIdentityTransport {
  get(ipAddress: string, timeoutMs: number, maxBodyBytes: number): Promise<unknown>;
}

const timeoutMs = 2_000;
const maxBodyBytes = 4_096;
const identityIdPattern = /^esp8266:[0-9a-f]{6}$/i;
export const ENERGRID_IDENTITY_TRANSPORT = Symbol('ENERGRID_IDENTITY_TRANSPORT');

/** Reads only the firmware's bounded, read-only identity endpoint. */
@Injectable()
export class EnergridHttpIdentityAdapter {
  private readonly transport: EnergridIdentityTransport;

  constructor(
    @Optional() @Inject(ENERGRID_IDENTITY_TRANSPORT) transport?: EnergridIdentityTransport,
  ) {
    this.transport = transport || new NodeEnergridIdentityTransport();
  }

  async identify(ipAddress: string): Promise<EnergridHttpIdentity | null> {
    if (!isPrivateIpv4(ipAddress)) return null;
    try {
      return parseEnergridIdentity(await this.transport.get(ipAddress, timeoutMs, maxBodyBytes));
    } catch {
      return null;
    }
  }
}

export function parseEnergridIdentity(value: unknown): EnergridHttpIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const identity = value as Record<string, unknown>;
  const capabilities = identity.capabilities;
  if (identity.schemaVersion !== 1 ||
      typeof identity.id !== 'string' || !identityIdPattern.test(identity.id) ||
      typeof identity.model !== 'string' || !identity.model.startsWith('Energrid ESP8266') ||
      typeof identity.firmwareVersion !== 'string' || !Array.isArray(capabilities) ||
      !capabilities.includes('temperature') || !capabilities.includes('humidity')) {
    return null;
  }
  return {
    id: identity.id.toLowerCase(),
    model: identity.model.slice(0, 100),
    firmwareVersion: identity.firmwareVersion.slice(0, 40),
    capabilities: ['temperature', 'humidity'],
  };
}

class NodeEnergridIdentityTransport implements EnergridIdentityTransport {
  get(ipAddress: string, timeout: number, maxBytes: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = httpRequest({
        hostname: ipAddress,
        port: 80,
        method: 'GET',
        path: '/api/v1/identity',
        timeout,
        maxHeaderSize: maxBytes,
        agent: false,
      }, response => {
        if (response.statusCode !== 200) {
          response.destroy();
          reject(new Error('Identity endpoint returned a non-success status.'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy(new Error('Identity response exceeded the size limit.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('Identity endpoint returned invalid JSON.'));
          }
        });
        response.on('error', reject);
      });
      request.once('timeout', () => request.destroy(new Error('Identity request timed out.')));
      request.once('error', reject);
      request.end();
    });
  }
}

function isPrivateIpv4(value: string): boolean {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
