import { privateShellyBaseUrl } from '@energrid/domain-devices';

export interface ShellyRpcDeviceInfo {
  id?: string;
  mac?: string;
  model?: string;
  app?: string;
  gen?: number;
  firmware?: string;
  method?: string;
  observedAt?: string;
}

export type ShellyRpcIdentityReadResult =
  | { status: 'verified'; info: ShellyRpcDeviceInfo }
  | { status: 'timeout' }
  | { status: 'unavailable' }
  | { status: 'invalid_response' };

/** Exact Gen2+ identity call used when fresh RPC identity is a gate. */
export async function readOnlyShellyRpcDeviceInfo(
  ipAddress: string,
  timeoutMs = 1200,
  externalSignal?: AbortSignal,
): Promise<ShellyRpcIdentityReadResult> {
  if (!isIPv4Address(ipAddress)) return { status: 'unavailable' };
  let baseUrl: string;
  try { baseUrl = privateShellyBaseUrl(`http://${ipAddress}`); }
  catch { return { status: 'unavailable' }; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(`${baseUrl}/rpc/Shelly.GetDeviceInfo`, {
      method: 'GET', signal: controller.signal,
      headers: { Accept: 'application/json' }, redirect: 'error',
    });
    if (!response.ok) return { status: 'invalid_response' };
    const body = await response.json() as Record<string, unknown>;
    const info = readOnlyShellyRpcDeviceInfoFromBody(body, 'GET /rpc/Shelly.GetDeviceInfo');
    return info ? { status: 'verified', info } : { status: 'invalid_response' };
  } catch {
    return controller.signal.aborted ? { status: 'timeout' } : { status: 'unavailable' };
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abort);
  }
}

/** Apply the same typed identity validation to an authenticated observer response. */
export function readOnlyShellyRpcDeviceInfoFromBody(
  value: unknown,
  method = 'GET /rpc/Shelly.GetDeviceInfo',
): ShellyRpcDeviceInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  return looksLikeShelly(body) ? deviceInfo(body, method) : null;
}

export async function readOnlyShellyDeviceInfo(
  ipAddress: string,
  timeoutMs = 1200,
): Promise<ShellyRpcDeviceInfo | null> {
  if (!isIPv4Address(ipAddress)) return null;
  let baseUrl: string;
  try {
    baseUrl = privateShellyBaseUrl(`http://${ipAddress}`);
  } catch {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (const path of ['/rpc/Shelly.GetDeviceInfo', '/shelly']) {
      try {
        const response = await fetch(`${baseUrl}${path}`, {
          method: 'GET',
          signal: controller.signal,
          headers: { Accept: 'application/json' },
          redirect: 'error',
        });
        if (!response.ok) continue;
        const body = await response.json() as Record<string, unknown>;
        if (!looksLikeShelly(body)) continue;
        return deviceInfo(body, `GET ${path}`);
      } catch {
        if (controller.signal.aborted) return null;
      }
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function deviceInfo(body: Record<string, unknown>, method: string): ShellyRpcDeviceInfo {
  return {
    method,
    observedAt: new Date().toISOString(),
    ...(stringValue(body.id) ? { id: stringValue(body.id) } : {}),
    ...(stringValue(body.mac) ? { mac: stringValue(body.mac) } : {}),
    ...(stringValue(body.model || body.type) ? { model: stringValue(body.model || body.type) } : {}),
    ...(stringValue(body.app || body.app_name) ? { app: stringValue(body.app || body.app_name) } : {}),
    ...(numberValue(body.gen) !== undefined ? { gen: numberValue(body.gen) } : {}),
    ...(stringValue(body.fw_id) || stringValue(body.fw) ? { firmware: stringValue(body.fw_id) || stringValue(body.fw) } : {}),
  };
}

export function isIPv4Address(value: string): boolean {
  const octets = value.split('.');
  return octets.length === 4 && octets.every(octet => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const number = Number(octet);
    return number >= 0 && number <= 255 && String(number) === octet;
  });
}

function looksLikeShelly(body: Record<string, unknown>): boolean {
  return Boolean(
    stringValue(body.id) || stringValue(body.mac) || stringValue(body.model) ||
    stringValue(body.type) || stringValue(body.app) || stringValue(body.app_name) ||
    numberValue(body.gen) !== undefined,
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
