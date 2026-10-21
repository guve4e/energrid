import type { NetworkDiscoverySnapshot } from './network-discovery-snapshot';

export interface NetworkRoleEvidence {
  id: string;
  role: 'default_gateway';
  label: 'Observed default gateway';
  scopeId: string;
  scopeName: string;
  ipAddress: string;
  observedAt: string;
  observer: { id: string; host: string; interfaceName: string };
  routeDestination: string;
  routeEvidence: string;
}

/** Projects a network role only from a matching default route and local scope in this snapshot. */
export function projectNetworkRoles(snapshot: NetworkDiscoverySnapshot): NetworkRoleEvidence[] {
  const runtime = snapshot.runtime;
  if (!runtime || !validTimestamp(runtime.observedAt)) return [];
  const roles: NetworkRoleEvidence[] = [];

  for (const scope of snapshot.scopes) {
    if (!scope.cidr) continue;
    const configured = runtime.configuredScopes.find(item => item.id === scope.id && item.cidr === scope.cidr);
    if (!configured || configured.reachability !== 'on_link') continue;

    for (const route of runtime.routes) {
      if (route.family !== 'IPv4' || route.destination !== '0.0.0.0/0' || !route.gateway || !route.interfaceName) continue;
      const directlyObservedScope = runtime.localScopes.some(item => item.cidr === scope.cidr && item.interfaceName === route.interfaceName);
      const configuredInterfaceMatches = configured.interfaceName === route.interfaceName;
      if (!directlyObservedScope || !configuredInterfaceMatches || !ipv4InCidr(route.gateway, scope.cidr)) continue;

      for (const endpoint of snapshot.endpoints) {
        if (endpoint.networkZoneId !== scope.id || endpoint.ipAddress !== route.gateway) continue;
        roles.push({
          id: `role:default-gateway:${snapshot.scanId}:${scope.id}:${endpoint.ipAddress}:${route.interfaceName}`,
          role: 'default_gateway',
          label: 'Observed default gateway',
          scopeId: scope.id,
          scopeName: scope.name,
          ipAddress: endpoint.ipAddress,
          observedAt: runtime.observedAt,
          observer: { id: runtime.observer.id, host: runtime.observer.host, interfaceName: route.interfaceName },
          routeDestination: route.destination,
          routeEvidence: route.evidence,
        });
      }
    }
  }

  return roles;
}

function ipv4InCidr(address: string, cidr: string): boolean {
  const [network, prefixText] = cidr.split('/');
  const toNumber = (value: string): number | null => {
    const octets = value.split('.').map(Number);
    if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    return octets.reduce((result, octet) => result * 256 + octet, 0);
  };
  const addressNumber = toNumber(address);
  const networkNumber = toNumber(network);
  const prefix = Number(prefixText);
  if (addressNumber === null || networkNumber === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const divisor = 2 ** (32 - prefix);
  return Math.floor(addressNumber / divisor) === Math.floor(networkNumber / divisor);
}

function validTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}
