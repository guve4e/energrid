import { createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';
import type { DiscoveryOwnership } from './device-discovery-memory.store';
import type { NetworkDiscoveredDevice, NetworkDiscoveryZone } from './device-registry.types';

export const SITE_LOCAL_SHELLY_EVIDENCE_MAX_AGE_MS = 15 * 60_000;
const supportedComponents = new Set(['switch', 'em1']);

export interface AuthorizedSiteLocalObserver {
  id: string;
  host: string;
  /** Optional SSH alias used by the API to supervise a persistent read-only worker on this host. */
  sshTarget?: string;
  tenantId: string;
  siteId: string;
  scopeId: string;
  cidr: string;
  interfaceName?: string;
  /** Optional legacy restriction. When omitted, site-owned inventory and assignments authorize targets. */
  expectedDeviceIds?: string[];
  expectedComponentKeys?: string[];
}

export type SiteLocalObserverSelection =
  | { observer: AuthorizedSiteLocalObserver; reason: 'selected' }
  | { observer: null; reason: 'observer_identity_not_authorized' | 'observer_component_not_authorized' | 'observer_assignment_ambiguous' };

/** Select one observer for the exact site/scope. Persisted inventory owns target authorization; optional legacy allowlists can further narrow it. */
export function selectAuthorizedSiteLocalObserver(input: {
  observers: AuthorizedSiteLocalObserver[];
  tenantId: string;
  siteId: string;
  scopeId: string;
  physicalId: string;
  component: string;
}): SiteLocalObserverSelection {
  const scoped = input.observers.filter(observer => observer.tenantId === input.tenantId &&
    observer.siteId === input.siteId && observer.scopeId === input.scopeId);
  const identityMatches = scoped.filter(observer => !observer.expectedDeviceIds || observer.expectedDeviceIds.some(id =>
    id.toLowerCase() === input.physicalId.toLowerCase()));
  if (!identityMatches.length) return { observer: null, reason: 'observer_identity_not_authorized' };
  const assignmentMatches = identityMatches.filter(observer => !observer.expectedComponentKeys ||
    observer.expectedComponentKeys.includes(input.component));
  if (!assignmentMatches.length) return { observer: null, reason: 'observer_component_not_authorized' };
  if (assignmentMatches.length !== 1) return { observer: null, reason: 'observer_assignment_ambiguous' };
  return { observer: assignmentMatches[0], reason: 'selected' };
}

export interface SiteLocalShellyEvidenceInput {
  reportId: string;
  observerId: string;
  scopeId: string;
  scopeCidr: string;
  startedAt: string;
  completedAt: string;
  observer: { host: string; observedAt: string; interfaceName: string; address: string; cidr: string; routeCidr: string };
  scan: { status: string; mode: string; targetCount: number; hostDiscoveryComplete: boolean; serviceEnrichmentComplete: boolean; endpoints: Array<{ ipAddress: string; observedAt: string }> };
  endpoint: { ipAddress: string; observedMacAddress?: string; hostname?: string };
  identity: { method: string; observedAt: string; response: { id: string; mac: string; model?: string; app?: string; gen: number; ver?: string; fw_id?: string } };
  components: Array<{ key: string; method: string; observedAt: string; response: Record<string, unknown> }>;
}

export function configuredSiteLocalObservers(raw = process.env.HOME_SITE_LOCAL_OBSERVERS_JSON): AuthorizedSiteLocalObserver[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('HOME_SITE_LOCAL_OBSERVERS_JSON is malformed.'); }
  if (!Array.isArray(parsed)) throw new Error('HOME_SITE_LOCAL_OBSERVERS_JSON must be an array.');
  return parsed.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Site-local observer authorization is malformed.');
    const value = item as Record<string, unknown>;
    for (const key of ['id', 'host', 'tenantId', 'siteId', 'scopeId', 'cidr']) {
      if (typeof value[key] !== 'string' || !(value[key] as string).trim()) throw new Error(`Site-local observer authorization requires ${key}.`);
    }
    if (value.sshTarget !== undefined && (typeof value.sshTarget !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,127}$/.test(value.sshTarget))) {
      throw new Error('Site-local observer SSH target must be a safe configured SSH alias or host.');
    }
    if (value.expectedDeviceIds !== undefined && (!Array.isArray(value.expectedDeviceIds) || !value.expectedDeviceIds.length || value.expectedDeviceIds.length > 32 ||
        value.expectedDeviceIds.some(id => typeof id !== 'string' || !/^shelly[a-z0-9._-]{1,114}$/i.test(id)))) {
      throw new Error('Site-local observer identity restrictions must be a bounded list of Shelly physical identities.');
    }
    if (value.expectedComponentKeys !== undefined && (!Array.isArray(value.expectedComponentKeys) ||
        value.expectedComponentKeys.length === 0 || value.expectedComponentKeys.length > 32 ||
        value.expectedComponentKeys.some(key => typeof key !== 'string' || !/^(?:switch|em1):(?:[0-9]|[12][0-9]|3[01])$/.test(key)))) {
      throw new Error('Site-local observer component authorization must be a bounded list of Shelly components.');
    }
    return value as unknown as AuthorizedSiteLocalObserver;
  });
}

/**
 * Validates the deliberately narrow operator-submitted observer report. The Portal
 * admin session and server-side observer/site/scope allowlist are the trust boundary;
 * report payload fields never supply tenant/site ownership or enrollment state.
 */
export function validateSiteLocalShellyEvidence(input: unknown, options: {
  ownership: DiscoveryOwnership;
  zones: NetworkDiscoveryZone[];
  observers: AuthorizedSiteLocalObserver[];
  now?: number;
}): { device: NetworkDiscoveredDevice; scanId: string; observer: AuthorizedSiteLocalObserver } {
  const body = asRecord(input, 'Site-local evidence report is malformed.') as unknown as SiteLocalShellyEvidenceInput;
  if (!/^[a-zA-Z0-9_-]{8,96}$/.test(body.reportId || '')) throw new Error('A unique observer report ID is required.');
  const observer = options.observers.find(item => item.id === body.observerId);
  if (!observer || observer.tenantId !== options.ownership.tenantId || observer.siteId !== options.ownership.siteId ||
      observer.scopeId !== body.scopeId || observer.cidr !== body.scopeCidr) throw new Error('Observer is not authorized for the active site and network scope.');
  const zone = options.zones.find(item => item.id === observer.scopeId);
  if (!zone || zone.collectionSource === 'virtual-lab' || zone.cidr !== observer.cidr || zone.cidr !== body.scopeCidr) {
    throw new Error('Observer report scope does not match a configured site network.');
  }
  if (body.observer?.host !== observer.host || body.observer?.cidr !== observer.cidr || body.observer?.routeCidr !== observer.cidr ||
      typeof body.observer?.interfaceName !== 'string' || !body.observer.interfaceName.trim() ||
      !ipv4InCidr(body.observer?.address, observer.cidr)) throw new Error('Observer identity or directly connected route does not match its authorization.');
  if (body.scan?.status !== 'targeted_complete' || body.scan.mode !== 'single_target_read_only' ||
      body.scan.targetCount !== 1 || body.scan.hostDiscoveryComplete !== false || body.scan.serviceEnrichmentComplete !== true ||
      !Array.isArray(body.scan.endpoints) || body.scan.endpoints.length !== 1 ||
      body.scan.endpoints[0]?.ipAddress !== body.endpoint?.ipAddress) {
    throw new Error('A completed single-target read-only report containing exactly the endpoint is required; subnet-scan reports are not accepted here.');
  }
  if (!ipv4InCidr(body.endpoint?.ipAddress, observer.cidr)) throw new Error('Shelly endpoint is outside the authorized network scope.');
  const info = body.identity?.response;
  if (body.identity?.method !== 'GET /rpc/Shelly.GetDeviceInfo' || !info ||
      !/^shelly[a-z0-9._-]{1,114}$/i.test(info.id || '') || info.gen < 2 || !Number.isInteger(info.gen) ||
      typeof info.mac !== 'string' || !normalizeMac(info.mac) || typeof info.model !== 'string' || !info.model.trim()) {
    throw new Error('Fresh exact Shelly Gen2+ device identity evidence is required.');
  }
  if (observer.expectedDeviceIds && !observer.expectedDeviceIds.some(id => id.toLowerCase() === info.id.toLowerCase())) {
    throw new Error('Reported Shelly identity does not match the server-authorized physical identity restriction.');
  }
  if (body.endpoint.observedMacAddress && normalizeMac(body.endpoint.observedMacAddress) !== normalizeMac(info.mac)) {
    throw new Error('Observed LAN MAC conflicts with the Shelly device-reported MAC.');
  }
  if (!Array.isArray(body.components) || !body.components.length || body.components.length > 32) {
    throw new Error('A bounded list of individually verified Shelly components is required.');
  }
  const components = new Set<string>();
  const observations: NonNullable<NetworkDiscoveredDevice['observations']> = [
    { source: 'http_identity', attribute: 'identity.verified', value: true, observedAt: body.identity.observedAt, scopeId: zone.id, interfaceName: body.observer.interfaceName, method: body.identity.method },
    { source: 'http_identity', attribute: 'identity.device_id', value: info.id, observedAt: body.identity.observedAt, scopeId: zone.id, interfaceName: body.observer.interfaceName, method: body.identity.method },
    { source: 'http_identity', attribute: 'identity.mac', value: info.mac, observedAt: body.identity.observedAt, scopeId: zone.id, interfaceName: body.observer.interfaceName, method: body.identity.method },
    { source: 'site_local_http_rpc', attribute: 'observer.identity', value: observer.id, observedAt: body.observer.observedAt, scopeId: zone.id, interfaceName: body.observer.interfaceName, method: 'authorized-site-local-observer-report' },
  ];
  const verifiedComponents: Array<{ component: string; channel: number }> = [];
  for (const item of body.components) {
    const match = /^(switch|em1):(\d{1,2})$/.exec(item.key || '');
    if (!match || !supportedComponents.has(match[1]) || item.method !== `${match[1] === 'switch' ? 'Switch' : 'EM1'}.GetStatus?id=${Number(match[2])}` ||
        components.has(item.key) || !confirmedComponent(match[1], Number(match[2]), item.response)) {
      throw new Error(`Unsupported or mismatched Shelly component evidence: ${String(item.key)}.`);
    }
    if (observer.expectedComponentKeys && !observer.expectedComponentKeys.includes(item.key)) {
      throw new Error(`Shelly component is outside the observer authorization: ${item.key}.`);
    }
    components.add(item.key);
    verifiedComponents.push({ component: item.key, channel: Number(match[2]) });
    observations.push({ source: 'site_local_http_rpc', attribute: 'shelly.component_status', value: item.key,
      observedAt: item.observedAt, scopeId: zone.id, interfaceName: body.observer.interfaceName, method: item.method });
    for (const field of supportedMeasurementFields(item.response)) observations.push({
      source: 'site_local_http_rpc', attribute: 'shelly.measurement_capability', value: `${item.key}:${field}`,
      observedAt: item.observedAt, scopeId: zone.id, interfaceName: body.observer.interfaceName, method: item.method,
    });
  }
  const now = options.now ?? Date.now();
  const times = [body.startedAt, body.completedAt, body.observer.observedAt, body.identity.observedAt,
    ...body.scan.endpoints.filter(item => item.ipAddress === body.endpoint.ipAddress).map(item => item.observedAt),
    ...body.components.map(item => item.observedAt)];
  for (const timestamp of times) {
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed) || parsed > now + 30_000 || now - parsed > SITE_LOCAL_SHELLY_EVIDENCE_MAX_AGE_MS) {
      throw new Error('Observer evidence timestamp is stale, invalid, or in the future.');
    }
  }
  if (Date.parse(body.completedAt) < Date.parse(body.startedAt)) throw new Error('Observer report timestamps are out of order.');
  const canonicalEvidence = JSON.stringify({ observer: observer.id, scope: observer.cidr, identity: info.id, ip: body.endpoint.ipAddress,
    identityAt: body.identity.observedAt, components: [...body.components].sort((a, b) => a.key.localeCompare(b.key)).map(item => [item.key, item.observedAt, item.method, item.response]) });
  const scanId = `site-observer-${createHash('sha256').update(canonicalEvidence).digest('hex').slice(0, 40)}`;
  return {
    observer,
    scanId,
    device: {
      id: info.id, ipAddress: body.endpoint.ipAddress, networkZoneId: zone.id, networkZoneName: zone.name,
      ...(body.endpoint.observedMacAddress ? { macAddress: normalizeMac(body.endpoint.observedMacAddress) } : {}),
      deviceReportedMacAddress: normalizeMac(info.mac),
      ...(body.endpoint.hostname ? { hostname: body.endpoint.hostname } : {}), vendor: 'Shelly', protocol: 'http', confidence: 0.98,
      status: 'online', model: info.model, app: info.app, generation: info.gen,
      ...(info.ver ? { firmwareVersion: info.ver } : {}), components: verifiedComponents,
      discoveredAt: body.completedAt, reason: 'Exact Shelly identity and component status RPC evidence submitted by an authorized site-local observer.', observations,
    },
  };
}

function asRecord(value: unknown, message: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, any>;
}

function confirmedComponent(kind: string, id: number, value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  if (status.id !== id) return false;
  if (kind === 'switch') return typeof status.output === 'boolean';
  return typeof status.act_power === 'number' && Number.isFinite(status.act_power);
}

function supportedMeasurementFields(value: Record<string, unknown>): string[] {
  const energy = (key: string) => {
    const record = value[key];
    return record && typeof record === 'object' && !Array.isArray(record) ? (record as Record<string, unknown>).total : undefined;
  };
  return [
    ...(typeof value.apower === 'number' && Number.isFinite(value.apower) || typeof value.act_power === 'number' && Number.isFinite(value.act_power) ? ['power'] : []),
    ...(typeof value.total_act_energy === 'number' && Number.isFinite(value.total_act_energy) || typeof energy('aenergy') === 'number' && Number.isFinite(energy('aenergy')) ? ['energy_import_total'] : []),
    ...(typeof value.total_act_ret_energy === 'number' && Number.isFinite(value.total_act_ret_energy) || typeof energy('ret_aenergy') === 'number' && Number.isFinite(energy('ret_aenergy')) ? ['energy_export_total'] : []),
  ];
}

function normalizeMac(value: string): string | undefined {
  const hex = value.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return hex.length === 12 ? hex.match(/.{2}/g)?.join(':') : undefined;
}

function ipv4InCidr(address: unknown, cidr: string): boolean {
  if (typeof address !== 'string' || !isIPv4(address)) return false;
  const [network, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  if (!isIPv4(network) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const number = (ip: string) => ip.split('.').reduce((sum, octet) => (sum * 256 + Number(octet)) >>> 0, 0);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (number(address) & mask) === (number(network) & mask);
}
