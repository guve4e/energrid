import type { DeviceEnrollment } from '@energrid/domain-devices'
import type { PhysicalDeviceInventoryRecord } from '../devices/enrollment/physical-device-inventory.repository'

export type PortalEnrollmentIdentityLink = DeviceEnrollment & {
  physicalIdentityValues: string[]
  ambiguousPhysicalIdentityValues: string[]
  physicalDeviceCount: number
}

/** Adds only identity claims reached through an exact logical assignment in the same tenant/site. */
export function projectEnrollmentIdentityLinks(
  scope: { tenantId: string; siteId: string },
  enrollments: readonly DeviceEnrollment[],
  physicalDevices: readonly PhysicalDeviceInventoryRecord[],
): PortalEnrollmentIdentityLink[] {
  const scopedDevices = physicalDevices.filter(device =>
    device.scope.tenantId === scope.tenantId && device.scope.siteId === scope.siteId,
  )

  return enrollments.map(enrollment => {
    const assigned = scopedDevices.filter(device =>
      device.assignments.some(assignment => assignment.deviceId === enrollment.deviceId),
    )
    const identityAssignments = new Map<string, number>()
    for (const device of assigned) {
      const value = device.identity?.value
      if (value) identityAssignments.set(value.toLowerCase(), (identityAssignments.get(value.toLowerCase()) || 0) + 1)
    }
    return {
      ...enrollment,
      physicalIdentityValues: [...new Set(assigned.flatMap(device =>
        device.identity?.value ? [device.identity.value] : [],
      ))],
      ambiguousPhysicalIdentityValues: [...identityAssignments.entries()]
        .filter(([, count]) => count > 1)
        .map(([value]) => value),
      physicalDeviceCount: assigned.length,
    }
  })
}
