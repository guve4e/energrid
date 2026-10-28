import { describe, expect, it } from '@jest/globals'
import type { DeviceEnrollment } from '@energrid/domain-devices'
import type { PhysicalDeviceInventoryRecord } from '../devices/enrollment/physical-device-inventory.repository'
import { projectEnrollmentIdentityLinks } from './enrollment-identity-projection'

const scope = { tenantId: 'tenant-demo', siteId: 'site-home' }

function enrollment(deviceId: string): DeviceEnrollment {
  return {
    schemaVersion: 1,
    tenantId: scope.tenantId,
    siteId: scope.siteId,
    deviceId,
    displayName: 'Garage ESP8266',
    status: 'enrolled',
    enrolledAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  }
}

function physical(
  physicalDeviceId: string,
  deviceId: string,
  identityValue: string,
  deviceScope = scope,
): PhysicalDeviceInventoryRecord {
  return {
    physicalDeviceId,
    scope: deviceScope,
    identity: { namespace: 'energrid:firmware-device-id:upstream-lan', value: identityValue },
    verificationStatus: 'hardware_verified',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    components: [],
    endpoints: [],
    networkObservations: [],
    assignments: [{
      deviceId,
      physicalDeviceId,
      assignedAt: '2026-01-01T00:00:00.000Z',
      assignedBy: 'installer',
    }],
  }
}

describe('portal enrollment identity projection', () => {
  it('projects the ESP8266 firmware identity through its exact durable physical assignment', () => {
    const logicalId = 'device:upstream-lan:esp8266:324864'
    const result = projectEnrollmentIdentityLinks(scope, [enrollment(logicalId)], [
      physical('9eb9efe0-0930-4564-8009-7dad1ad10819', logicalId, 'esp8266:324864'),
    ])

    expect(result[0]).toMatchObject({
      deviceId: logicalId,
      physicalIdentityValues: ['esp8266:324864'],
      physicalDeviceCount: 1,
    })
  })

  it('includes only assigned physical records from the enrollment tenant/site scope', () => {
    const logicalId = 'device:upstream-lan:esp8266:324864'
    const result = projectEnrollmentIdentityLinks(scope, [enrollment(logicalId)], [
      physical('other-device', logicalId, 'prefix-esp8266:324864'),
      physical('other-site', logicalId, 'esp8266:324864', { tenantId: 'tenant-demo', siteId: 'other-site' }),
    ])

    expect(result[0].physicalIdentityValues).toEqual(['prefix-esp8266:324864'])
  })

  it('retains multiple assignment identities so the UI can report ambiguity', () => {
    const logicalId = 'device:upstream-lan:esp8266:324864'
    const result = projectEnrollmentIdentityLinks(scope, [enrollment(logicalId)], [
      physical('physical-a', logicalId, 'esp8266:324864'),
      physical('physical-b', logicalId, 'esp8266:324864'),
    ])

    expect(result[0]).toMatchObject({
      physicalIdentityValues: ['esp8266:324864'],
      ambiguousPhysicalIdentityValues: ['esp8266:324864'],
      physicalDeviceCount: 2,
    })
  })

  it('projects distinct component assignments for two logical records on one physical device', () => {
    const switch0 = 'shellypro2pm-ec6260888084:switch:0'
    const switch1 = 'shellypro2pm-ec6260888084:switch:1'
    const physicalId = '8e15ec60-a22b-4f8c-ab09-5e61d44030f9'
    const inventory = physical(physicalId, switch0, 'shellypro2pm-ec6260888084')
    inventory.assignments = [
      { deviceId: switch0, physicalDeviceId: physicalId, componentKey: 'switch:0', assignedAt: '2026-01-01T00:00:00.000Z', assignedBy: 'operator' },
      { deviceId: switch1, physicalDeviceId: physicalId, componentKey: 'switch:1', assignedAt: '2026-01-01T00:00:00.000Z', assignedBy: 'operator' },
    ]

    const result = projectEnrollmentIdentityLinks(scope, [enrollment(switch0), enrollment(switch1)], [inventory])

    expect(result.map(item => item.physicalAssignments)).toEqual([
      [{ physicalDeviceId: physicalId, componentKey: 'switch:0' }],
      [{ physicalDeviceId: physicalId, componentKey: 'switch:1' }],
    ])
    expect(result.map(item => item.ambiguousPhysicalIdentityValues)).toEqual([[], []])
  })

  it('keeps separately stored physical records with the same identity flagged as a conflict', () => {
    const logicalId = 'shellypro2pm-ec6260888084:switch:0'
    const identity = 'shellypro2pm-ec6260888084'

    const result = projectEnrollmentIdentityLinks(scope, [enrollment(logicalId)], [
      physical('physical-a', logicalId, identity),
      physical('physical-b', logicalId, identity),
    ])

    expect(result[0]).toMatchObject({
      physicalDeviceCount: 2,
      ambiguousPhysicalIdentityValues: [identity],
    })
    expect(result[0].physicalAssignments.map(assignment => assignment.physicalDeviceId)).toEqual(['physical-a', 'physical-b'])
  })
})
