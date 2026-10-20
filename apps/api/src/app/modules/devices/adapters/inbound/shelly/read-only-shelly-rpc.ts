import { privateShellyBaseUrl } from '@energrid/domain-devices';

export interface ShellyRpcDeviceInfo {
  id?: string;
  mac?: string;
  model?: string;
  app?: string;
  gen?: number;
  firmware?: string;
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
        return {
          ...(stringValue(body.id) ? { id: stringValue(body.id) } : {}),
          ...(stringValue(body.mac) ? { mac: stringValue(body.mac) } : {}),
          ...(stringValue(body.model || body.type) ? { model: stringValue(body.model || body.type) } : {}),
          ...(stringValue(body.app || body.app_name) ? { app: stringValue(body.app || body.app_name) } : {}),
          ...(numberValue(body.gen) !== undefined ? { gen: numberValue(body.gen) } : {}),
          ...(stringValue(body.fw_id) || stringValue(body.fw) ? { firmware: stringValue(body.fw_id) || stringValue(body.fw) } : {}),
        };
      } catch {
        if (controller.signal.aborted) return null;
      }
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
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
