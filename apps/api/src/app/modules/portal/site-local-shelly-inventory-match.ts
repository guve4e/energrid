import { hasPhysicalDeviceIdentityClaim, type PhysicalDeviceInventoryRecord } from '../devices/enrollment/physical-device-inventory.repository'

/** Matches only an existing, server-owned physical inventory assignment for this exact Shelly component. */
export function findExactShellyInventoryAssignment(
  inventories: readonly PhysicalDeviceInventoryRecord[],
  ownership: { tenantId: string; siteId: string },
  deviceId: string,
  physicalId: string,
  component: string,
): PhysicalDeviceInventoryRecord | null {
  const identityClaims = inventories.filter(inventory =>
    inventory.scope.tenantId === ownership.tenantId && inventory.scope.siteId === ownership.siteId &&
    hasPhysicalDeviceIdentityClaim(inventory, 'mqtt:shelly-protocol-id', physicalId),
  )
  if (identityClaims.length !== 1) return null
  const matches = identityClaims.filter(inventory => {
    const assignments = inventory.assignments.filter(item => item.deviceId === deviceId)
    return inventory.components.some(item => item.key === component) && assignments.length === 1 &&
      assignments[0].physicalDeviceId === inventory.physicalDeviceId && assignments[0].componentKey === component
  })
  return matches.length === 1 ? matches[0] : null
}
