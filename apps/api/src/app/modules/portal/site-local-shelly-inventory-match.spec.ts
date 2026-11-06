import { findExactShellyInventoryAssignment } from './site-local-shelly-inventory-match'
import type { PhysicalDeviceInventoryRecord } from '../devices/enrollment/physical-device-inventory.repository'

const owner = { tenantId: 'tenant-demo', siteId: 'site-home' }
const physicalId = 'shellypro2pm-ec6260888084'
const inventoryId = '8e15ec60-a22b-4f8c-ab09-5e61d44030f9'
const device0 = `${physicalId}:switch:0`
const device1 = `${physicalId}:switch:1`

function record(overrides: Partial<PhysicalDeviceInventoryRecord> = {}): PhysicalDeviceInventoryRecord {
  return {
    physicalDeviceId: inventoryId,
    scope: owner,
    identity: { namespace: 'mqtt:shelly-protocol-id', value: physicalId },
    verificationStatus: 'protocol_observed',
    firstSeenAt: '2026-10-27T09:00:00.000Z', lastSeenAt: '2026-10-27T09:00:00.000Z',
    components: [
      { key: 'switch:0', capabilities: ['switch', 'power'], firstSeenAt: '2026-10-27T09:00:00.000Z', lastSeenAt: '2026-10-27T09:00:00.000Z' },
      { key: 'switch:1', capabilities: ['switch', 'power'], firstSeenAt: '2026-10-27T09:00:00.000Z', lastSeenAt: '2026-10-27T09:00:00.000Z' },
    ],
    endpoints: [], networkObservations: [],
    assignments: [
      { deviceId: device0, physicalDeviceId: inventoryId, componentKey: 'switch:0', assignedAt: '2026-10-27T09:00:00.000Z', assignedBy: 'operator' },
      { deviceId: device1, physicalDeviceId: inventoryId, componentKey: 'switch:1', assignedAt: '2026-10-27T09:00:00.000Z', assignedBy: 'operator' },
    ],
    ...overrides,
  }
}

describe('exact Shelly physical inventory assignment', () => {
  it('matches each existing logical component to the shared physical inventory independently', () => {
    expect(findExactShellyInventoryAssignment([record()], owner, device0, physicalId, 'switch:0')?.physicalDeviceId).toBe(inventoryId)
    expect(findExactShellyInventoryAssignment([record()], owner, device1, physicalId, 'switch:1')?.physicalDeviceId).toBe(inventoryId)
  })

  it('matches the protocol identity when it is a secondary claim behind the primary MAC claim', () => {
    const primaryMac = record({
      identity: { namespace: 'mac', value: '8c:4f:00:db:d2:58' },
      identities: [
        { namespace: 'mac', value: '8c:4f:00:db:d2:58' },
        { namespace: 'mqtt:shelly-protocol-id', value: physicalId },
      ],
    })

    expect(findExactShellyInventoryAssignment([primaryMac], owner, device0, physicalId, 'switch:0')?.physicalDeviceId).toBe(inventoryId)
  })

  it('rejects wrong component, identity, physical record, cross-site, duplicate assignments, and ambiguous physical records', () => {
    expect(findExactShellyInventoryAssignment([record()], owner, device0, physicalId, 'switch:1')).toBeNull()
    expect(findExactShellyInventoryAssignment([record()], owner, `${physicalId}:switch:2`, physicalId, 'switch:2')).toBeNull()
    expect(findExactShellyInventoryAssignment([record()], owner, device0, 'shellyplus1-000000000000', 'switch:0')).toBeNull()
    expect(findExactShellyInventoryAssignment([record({ scope: { tenantId: owner.tenantId, siteId: 'site-device-lab' } })], owner, device0, physicalId, 'switch:0')).toBeNull()
    expect(findExactShellyInventoryAssignment([record({ physicalDeviceId: 'physical-other' })], owner, device0, physicalId, 'switch:0')).toBeNull()
    expect(findExactShellyInventoryAssignment([record({ assignments: [...record().assignments, record().assignments[0]] })], owner, device0, physicalId, 'switch:0')).toBeNull()
    expect(findExactShellyInventoryAssignment([record(), record({ physicalDeviceId: 'physical-other' })], owner, device0, physicalId, 'switch:0')).toBeNull()
  })
})
