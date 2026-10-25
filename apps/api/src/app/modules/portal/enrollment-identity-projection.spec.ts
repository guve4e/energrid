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
})
