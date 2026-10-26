import type { NetworkDeviceEndpoint, NetworkDiscoveredDevice } from './device-registry.types'

export function normalizeNetworkHostname(value: string): string {
  return value.trim().replace(/\.$/, '').toLowerCase()
}

export function networkEndpointIdentity(
  device: Pick<NetworkDiscoveredDevice, 'networkZoneId' | 'ipAddress'>,
): string {
  return `endpoint:${device.networkZoneId}:${device.ipAddress}`
}

export function dedupeNetworkEndpoints(devices: NetworkDiscoveredDevice[]): NetworkDiscoveredDevice[] {
  const byEndpoint = new Map<string, NetworkDiscoveredDevice[]>()
  for (const device of devices) {
    const identity = networkEndpointIdentity(device)
    const group = byEndpoint.get(identity) || []
    group.push(device)
    byEndpoint.set(identity, group)
  }
  return [...byEndpoint.values()].map(mergeEndpointEvidence).sort((a, b) =>
    a.networkZoneId.localeCompare(b.networkZoneId) || a.ipAddress.localeCompare(b.ipAddress),
  )
}

export function mergeEndpointEvidence(devices: NetworkDiscoveredDevice[]): NetworkDiscoveredDevice {
  const latestObservedAt = devices.reduce((latest, device) => device.discoveredAt > latest ? device.discoveredAt : latest, devices[0].discoveredAt)
  const currentDevices = devices.filter(device => device.discoveredAt === latestObservedAt)
  const currentMacAddresses = [...new Set(currentDevices
    .flatMap(device => [device.macAddress, ...(device.identityConflict?.macAddresses || [])])
    .map(mac => mac?.trim().toLowerCase())
    .filter((mac): mac is string => !!mac && mac !== 'ff:ff:ff:ff:ff:ff'))].sort()
  if (currentMacAddresses.length > 1) return conflictEndpointEvidence(currentDevices, currentMacAddresses)

  const currentMac = currentMacAddresses[0]
  const currentMacDevice = currentDevices.find(device => device.macAddress?.trim().toLowerCase() === currentMac)
  const currentHostname = normalizeNetworkHostname(currentMacDevice?.hostname || '')
  const identityDevices = currentMac
    ? devices.filter(device => device.macAddress?.trim().toLowerCase() === currentMac ||
      (!hasUsefulMac(device.macAddress) && currentHostname && normalizeNetworkHostname(device.hostname || '') === currentHostname))
    : currentDevices
  const preferred = [...identityDevices].sort((a, b) =>
    b.discoveredAt.localeCompare(a.discoveredAt) || b.confidence - a.confidence ||
    Number(hasUsefulMac(b.macAddress)) - Number(hasUsefulMac(a.macAddress)) ||
    normalizeNetworkHostname(b.hostname || '').localeCompare(normalizeNetworkHostname(a.hostname || '')),
  )[0]
  const macAddresses = [...new Set(identityDevices
    .flatMap(device => [device.macAddress, ...(device.identityConflict?.macAddresses || [])])
    .map(mac => mac?.trim().toLowerCase())
    .filter((mac): mac is string => !!mac && mac !== 'ff:ff:ff:ff:ff:ff'))].sort()
  const endpoints = new Map<string, NetworkDeviceEndpoint>()
  for (const device of identityDevices) {
    for (const endpoint of device.endpoints || [{
      ipAddress: device.ipAddress,
      networkZoneId: device.networkZoneId,
      networkZoneName: device.networkZoneName,
      ...(device.gatewayId ? { gatewayId: device.gatewayId } : {}),
      ...(device.macAddress ? { macAddress: device.macAddress } : {}),
    }]) {
      endpoints.set(`${endpoint.networkZoneId}:${endpoint.ipAddress}:${endpoint.macAddress?.toLowerCase() || ''}`, endpoint)
    }
  }
  const observations = new Map<string, NonNullable<NetworkDiscoveredDevice['observations']>[number]>()
  for (const device of identityDevices) {
    for (const observation of device.observations || []) {
      observations.set(`${observation.source}:${observation.attribute}:${String(observation.value)}:${observation.observedAt}`, observation)
    }
  }
  const components = new Map<string, NonNullable<NetworkDiscoveredDevice['components']>[number]>()
  for (const device of identityDevices) for (const component of device.components || []) components.set(component.component, component)
  const { identityConflict: _oldConflict, ...base } = preferred
  return {
    ...base,
    ...(macAddresses.length > 1 ? { identityConflict: { reason: 'multiple_macs_for_endpoint' as const, macAddresses } } : {}),
    endpoints: [...endpoints.values()].sort((a, b) => a.ipAddress.localeCompare(b.ipAddress) || (a.macAddress || '').localeCompare(b.macAddress || '')),
    observations: [...observations.values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.source.localeCompare(b.source) || a.attribute.localeCompare(b.attribute)),
    components: components.size ? [...components.values()].sort((a, b) => a.component.localeCompare(b.component)) : preferred.components,
  }
}

export function conflictEndpointEvidence(devices: NetworkDiscoveredDevice[], macAddresses: string[]): NetworkDiscoveredDevice {
  const endpoint = devices[0]
  const discoveredAt = devices.reduce((latest, device) => device.discoveredAt > latest ? device.discoveredAt : latest, endpoint.discoveredAt)
  const endpoints = new Map<string, NetworkDeviceEndpoint>()
  for (const device of devices) {
    for (const observedEndpoint of device.endpoints || [{
      ipAddress: device.ipAddress,
      networkZoneId: device.networkZoneId,
      networkZoneName: device.networkZoneName,
      ...(device.gatewayId ? { gatewayId: device.gatewayId } : {}),
      ...(device.macAddress ? { macAddress: device.macAddress } : {}),
    }]) {
      endpoints.set(`${observedEndpoint.networkZoneId}:${observedEndpoint.ipAddress}:${observedEndpoint.macAddress?.toLowerCase() || ''}`, observedEndpoint)
    }
  }
  return {
    id: networkEndpointIdentity(endpoint), ipAddress: endpoint.ipAddress,
    networkZoneId: endpoint.networkZoneId, networkZoneName: endpoint.networkZoneName,
    protocol: 'unknown', confidence: 0, status: 'unknown', discoveredAt,
    reason: 'Conflicting MAC identities were observed at this endpoint.',
    identityConflict: { reason: 'multiple_macs_for_endpoint', macAddresses },
    endpoints: [...endpoints.values()].sort((a, b) => a.ipAddress.localeCompare(b.ipAddress) || (a.macAddress || '').localeCompare(b.macAddress || '')),
  }
}

export function mergeNetworkHistory(previous: NetworkDiscoveredDevice, current: NetworkDiscoveredDevice): NetworkDiscoveredDevice {
  const latest = previous.discoveredAt.localeCompare(current.discoveredAt) > 0 ? previous : current
  const endpoints = new Map<string, NetworkDeviceEndpoint>()
  for (const device of [previous, current]) {
    for (const endpoint of device.endpoints || [{
      ipAddress: device.ipAddress,
      networkZoneId: device.networkZoneId,
      networkZoneName: device.networkZoneName,
      ...(device.gatewayId ? { gatewayId: device.gatewayId } : {}),
      ...(device.macAddress ? { macAddress: device.macAddress } : {}),
    }]) {
      endpoints.set(`${endpoint.networkZoneId}:${endpoint.ipAddress}:${endpoint.macAddress?.toLowerCase() || ''}`, endpoint)
    }
  }
  const merged = mergeEndpointEvidence([previous, current])
  return {
    ...latest,
    endpoints: [...endpoints.values()].sort((a, b) => a.ipAddress.localeCompare(b.ipAddress)),
    observations: merged.observations,
    ...(merged.identityConflict ? { identityConflict: merged.identityConflict } : {}),
  }
}

export function hasUsefulMac(value?: string): boolean {
  const mac = value?.trim().toLowerCase()
  return !!mac && mac !== 'ff:ff:ff:ff:ff:ff'
}
