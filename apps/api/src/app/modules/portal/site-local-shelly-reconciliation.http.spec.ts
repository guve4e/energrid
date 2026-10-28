import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceDiscoveryMemoryStore } from '../devices/device-discovery-memory.store'
import { PortalController } from './portal.controller'
import type { PhysicalDeviceInventoryRecord } from '../devices/enrollment/physical-device-inventory.repository'

const owner = { tenantId: 'tenant-demo', siteId: 'site-home' }
const physicalId = 'shellypro2pm-ec6260888084'
const component = 'switch:0'
const logicalId = `${physicalId}:${component}`
const physicalInventoryId = '8e15ec60-a22b-4f8c-ab09-5e61d44030f9'

function inventoryRecord(): PhysicalDeviceInventoryRecord {
  return {
    physicalDeviceId: physicalInventoryId,
    scope: owner,
    identity: { namespace: 'mqtt:shelly-protocol-id', value: physicalId },
    verificationStatus: 'protocol_observed',
    firstSeenAt: '2026-10-27T09:00:00.000Z',
    lastSeenAt: '2026-10-27T09:00:00.000Z',
    components: [
      { key: 'switch:0', capabilities: ['switch', 'power'], firstSeenAt: '2026-10-27T09:00:00.000Z', lastSeenAt: '2026-10-27T09:00:00.000Z' },
      { key: 'switch:1', capabilities: ['switch', 'power'], firstSeenAt: '2026-10-27T09:00:00.000Z', lastSeenAt: '2026-10-27T09:00:00.000Z' },
    ],
    endpoints: [], networkObservations: [],
    assignments: [
      { deviceId: logicalId, physicalDeviceId: physicalInventoryId, componentKey: component, assignedAt: '2026-10-27T09:00:00.000Z', assignedBy: 'operator' },
      { deviceId: `${physicalId}:switch:1`, physicalDeviceId: physicalInventoryId, componentKey: 'switch:1', assignedAt: '2026-10-27T09:00:00.000Z', assignedBy: 'operator' },
    ],
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

describe('site-local Shelly reconciliation HTTP workflow', () => {
  const previousObservers = process.env.HOME_SITE_LOCAL_OBSERVERS_JSON

  afterEach(() => {
    if (previousObservers === undefined) delete process.env.HOME_SITE_LOCAL_OBSERVERS_JSON
    else process.env.HOME_SITE_LOCAL_OBSERVERS_JSON = previousObservers
  })

  it('imports, reviews, and reconciles the Portal logical component ID against the persisted physical endpoint', async () => {
    const now = Date.now()
    const at = (offset = 0) => new Date(now + offset).toISOString()
    const observer = {
      id: 'pi-housenet', host: 'pi', tenantId: owner.tenantId, siteId: owner.siteId,
      scopeId: 'upstream-lan', cidr: '192.168.1.0/24', expectedDeviceIds: [physicalId],
    }
    process.env.HOME_SITE_LOCAL_OBSERVERS_JSON = JSON.stringify([observer])
    const report = {
      reportId: 'pi-report-http-test-20261028082026', observerId: observer.id,
      scopeId: observer.scopeId, scopeCidr: observer.cidr,
      startedAt: at(-1_500), completedAt: at(-100),
      observer: { host: 'pi', observedAt: at(-1_400), interfaceName: 'eth0', address: '192.168.1.6', cidr: observer.cidr, routeCidr: observer.cidr },
      scan: { status: 'targeted_complete', mode: 'single_target_read_only', targetCount: 1, hostDiscoveryComplete: false, serviceEnrichmentComplete: true,
        endpoints: [{ ipAddress: '192.168.1.166', observedAt: at(-80) }] },
      endpoint: { ipAddress: '192.168.1.166' },
      identity: { method: 'GET /rpc/Shelly.GetDeviceInfo', observedAt: at(-1_000), response: {
        id: physicalId, mac: 'EC:62:60:88:80:84', model: 'SPSW-202PE16EU', app: 'Pro2PM', gen: 2, ver: '2.0.0',
      } },
      components: [{ key: component, method: 'Switch.GetStatus?id=0', observedAt: at(-50), response: {
        id: 0, output: false, apower: 0, voltage: 230.8, current: 0,
        aenergy: { total: 0 }, ret_aenergy: { total: 0 },
      } }],
      status: 'targeted_complete',
    }
    const installedSwitch0 = {
      id: logicalId, displayName: 'Washer/Fan', zoneName: 'Bathroom', tenantId: owner.tenantId, siteId: owner.siteId,
      metadata: { physicalId, component, physicalInventoryId, identityEvidenceSource: 'mqtt_claim' },
      adapter: { driver: 'shelly-discovered' }, supportedCapabilities: [{ kind: 'power', authority: 'read-only' }],
    }
    const installedSwitch1 = {
      id: `${physicalId}:switch:1`, displayName: 'Shelly Pro 2PM switch:1', zoneName: 'Unknown', tenantId: owner.tenantId, siteId: owner.siteId,
      metadata: { physicalId, component: 'switch:1', physicalInventoryId }, adapter: { driver: 'shelly-discovered' },
    }
    const devices = [installedSwitch0, installedSwitch1]
    const registry = {
      getSnapshot: jest.fn(() => ({ tenant: { id: owner.tenantId }, site: { id: owner.siteId, name: 'Home' } })),
      getDevices: jest.fn(() => devices),
      ensureInstallationsLoaded: jest.fn(async () => undefined),
      registerDiscoveredDevice: jest.fn(),
      getShellyReconciliationTargetDecision: jest.fn(async (_tenantId, _siteId, deviceId) =>
        deviceId === logicalId ? { matched: true, device: installedSwitch0 } : { matched: false, reasonCode: 'logical_record_missing' }),
      reconcileShellyIdentityEvidence: jest.fn(async () => installedSwitch0),
    }
    const inventory = inventoryRecord()
    const physicalInventory = {
      list: jest.fn(async () => [inventory]),
      discover: jest.fn(async () => inventory),
    }
    const directory = await mkdtemp(join(tmpdir(), 'energrid-site-local-reconcile-'))
    const memory = new DeviceDiscoveryMemoryStore(directory)
    const controller = Object.assign(Object.create(PortalController.prototype), {
      deviceRegistry: registry,
      discoveryMemory: memory,
      physicalInventory,
      lanDiscovery: { getZones: () => [{ id: 'upstream-lan', name: 'Upstream LAN', cidr: '192.168.1.0/24', collectionSource: 'local' }] },
    }) as PortalController
    const request = { user: { role: 'admin' } }
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const reqBody = req.method === 'POST' ? await readJson(req) : undefined
        let result: unknown
        if (req.method === 'POST' && url.pathname === '/portal/network/site-local-shelly-evidence') {
          result = await controller.importSiteLocalShellyEvidence(reqBody, request as never)
        } else if (req.method === 'GET' && /^\/portal\/network\/site-local-shelly-evidence\/[^/]+\/review$/.test(url.pathname)) {
          const scanId = decodeURIComponent(url.pathname.split('/').at(-2)!)
          result = await controller.reviewSavedSiteLocalShellyEvidence(scanId, request as never)
        } else if (req.method === 'POST' && /^\/portal\/network\/site-local-shelly-evidence\/[^/]+\/reconcile$/.test(url.pathname)) {
          const scanId = decodeURIComponent(url.pathname.split('/').at(-2)!)
          result = await controller.reconcileSiteLocalShellyComponent(scanId, reqBody as never, request as never)
        } else {
          res.writeHead(404).end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
      } catch (error) {
        const status = typeof error === 'object' && error && 'getStatus' in error && typeof error.getStatus === 'function' ? error.getStatus() : 500
        const message = error instanceof Error ? error.message : 'Request failed'
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ message }))
      }
    })

    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Test HTTP listener did not bind a TCP port')
      const baseUrl = `http://127.0.0.1:${address.port}`

      const importedResponse = await fetch(`${baseUrl}/portal/network/site-local-shelly-evidence`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report),
      })
      expect(importedResponse.status).toBe(200)
      const imported = await importedResponse.json() as { scanId: string; reconciliationProposals: Array<{ deviceId: string; component: string; physicalInventoryId: string }> }
      expect(imported.reconciliationProposals).toEqual([expect.objectContaining({
        deviceId: logicalId, component, physicalInventoryId,
      })])

      const persisted = await memory.getSnapshot(imported.scanId, owner)
      expect(persisted).toMatchObject({ ownership: owner, collector: { host: 'pi' }, scopes: [{ id: 'upstream-lan', cidr: observer.cidr }] })
      expect(persisted?.endpoints).toEqual([expect.objectContaining({ id: physicalId, networkZoneId: observer.scopeId })])

      const reviewResponse = await fetch(`${baseUrl}/portal/network/site-local-shelly-evidence/${encodeURIComponent(imported.scanId)}/review`)
      expect(reviewResponse.status).toBe(200)
      const review = await reviewResponse.json() as { reconciliationProposals: Array<{ deviceId: string; component: string }> }
      expect(review.reconciliationProposals).toEqual([expect.objectContaining({ deviceId: logicalId, component })])

      // This is the exact body App.vue sends after the operator presses Record verified identity.
      const reconcileResponse = await fetch(`${baseUrl}/portal/network/site-local-shelly-evidence/${encodeURIComponent(imported.scanId)}/reconcile`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: review.reconciliationProposals[0].deviceId, component: review.reconciliationProposals[0].component }),
      })
      expect(reconcileResponse.status).toBe(200)
      expect(await reconcileResponse.json()).toMatchObject({
        status: 'identity_evidence_reconciled', deviceId: logicalId,
        enrollmentChanged: false, measurementAuthorityChanged: false, controlAuthorityChanged: false,
      })
      expect(registry.reconcileShellyIdentityEvidence).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: owner.tenantId, siteId: owner.siteId, deviceId: logicalId, physicalId, component, physicalInventoryId,
      }))
      expect(registry.registerDiscoveredDevice).not.toHaveBeenCalled()
      expect(devices.map(device => device.id)).toEqual([logicalId, `${physicalId}:switch:1`])

      const wrongEndpointResponse = await fetch(`${baseUrl}/portal/network/site-local-shelly-evidence/${encodeURIComponent(imported.scanId)}/reconcile`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: `${physicalId}-other:${component}`, component }),
      })
      expect(wrongEndpointResponse.status).toBe(400)
      expect(registry.reconcileShellyIdentityEvidence).toHaveBeenCalledTimes(1)
    } finally {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
      await memory.onModuleDestroy()
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)
})
