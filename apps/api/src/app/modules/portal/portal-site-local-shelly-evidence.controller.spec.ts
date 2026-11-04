import { BadRequestException, ForbiddenException, NotFoundException, RequestMethod, UnauthorizedException } from '@nestjs/common'
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AccessJwtGuard, RoleGuard } from '../auth/auth.guard'
import { PortalController } from './portal.controller'
import { PortalSiteLocalShellyEvidenceController } from './portal-site-local-shelly-evidence.controller'
import { PortalSiteLocalShellyEvidenceWorkflow } from './portal-site-local-shelly-evidence.workflow'

const admin = { user: { userId: 'operator', role: 'admin' }, headers: {} } as never
const viewer = { user: { userId: 'guest', role: 'viewer' }, headers: {} } as never
const anonymous = { headers: {} } as never
const ownership = { tenantId: 'tenant-one', siteId: 'site-home' }

function fixture() {
  const evidence = {
    importSiteLocalShellyEvidence: jest.fn().mockResolvedValue({ status: 'pending_review' }),
    reviewSavedSiteLocalShellyEvidence: jest.fn().mockResolvedValue({ status: 'pending_review' }),
    reconcileSiteLocalShellyComponent: jest.fn().mockResolvedValue({ status: 'identity_evidence_reconciled' }),
  }
  return { controller: new PortalSiteLocalShellyEvidenceController(evidence as never), evidence }
}

function workflowFixture() {
  const registry = {
    getSnapshot: jest.fn(() => ({ tenant: { id: ownership.tenantId }, site: { id: ownership.siteId, name: 'Home' } })),
    reconcileShellyIdentityEvidence: jest.fn(),
    registerDiscoveredDevice: jest.fn(),
  }
  const memory = { getSnapshot: jest.fn().mockResolvedValue(null) }
  const workflow = new PortalSiteLocalShellyEvidenceWorkflow(
    { getZones: () => [] } as never, registry as never, memory as never,
  )
  return { workflow, registry, memory }
}

const routes = [
  ['importSiteLocalShellyEvidence', 'network/site-local-shelly-evidence', RequestMethod.POST],
  ['reviewSavedSiteLocalShellyEvidence', 'network/site-local-shelly-evidence/:scanId/review', RequestMethod.GET],
  ['reconcileSiteLocalShellyComponent', 'network/site-local-shelly-evidence/:scanId/reconcile', RequestMethod.POST],
] as const

describe('P6d site-local Shelly evidence HTTP boundary', () => {
  it('preserves all three routes, JWT/admin metadata and Nest registration', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PortalSiteLocalShellyEvidenceController)).toBe('portal')
    expect(Reflect.getMetadata(GUARDS_METADATA, PortalSiteLocalShellyEvidenceController))
      .toEqual([AccessJwtGuard, RoleGuard])
    expect(Reflect.getMetadata('energrid.auth.roles', PortalSiteLocalShellyEvidenceController)).toEqual(['admin'])
    const moduleSource = readFileSync(join(__dirname, 'portal.module.ts'), 'utf8')
    expect(moduleSource).toMatch(/controllers\s*:\s*\[[^\]]*\bPortalSiteLocalShellyEvidenceController\b/)
    expect(moduleSource).toMatch(/providers\s*:\s*\[[^\]]*\bPortalSiteLocalShellyEvidenceWorkflow\b/)
    for (const [name, path, method] of routes) {
      const handler = PortalSiteLocalShellyEvidenceController.prototype[name]
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path)
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method)
      expect(Object.prototype.hasOwnProperty.call(PortalController.prototype, name)).toBe(false)
    }
  })

  it('enforces authentication and role with actual Nest guards', async () => {
    const reflector = new Reflector()
    const authenticateAccessToken = jest.fn().mockResolvedValue({ userId: 'guest', role: 'viewer' })
    const jwtGuard = new AccessJwtGuard({ authenticateAccessToken } as never, reflector)
    const roleGuard = new RoleGuard(reflector)
    const request: { headers: { authorization?: string }; user?: { userId: string; role: string } } = { headers: {} }
    const context = {
      getHandler: () => PortalSiteLocalShellyEvidenceController.prototype.importSiteLocalShellyEvidence,
      getClass: () => PortalSiteLocalShellyEvidenceController,
      switchToHttp: () => ({ getRequest: () => request }),
    } as never
    await expect(jwtGuard.canActivate(context)).rejects.toThrow(UnauthorizedException)
    request.headers.authorization = 'Bearer test-token'
    await expect(jwtGuard.canActivate(context)).resolves.toBe(true)
    expect(() => roleGuard.canActivate(context)).toThrow(ForbiddenException)
    request.user = { userId: 'operator', role: 'admin' }
    expect(roleGuard.canActivate(context)).toBe(true)
  })

  it.each([anonymous, viewer])('rejects non-admin callers before consulting the workflow', async request => {
    const { controller, evidence } = fixture()
    for (const invoke of [
      () => controller.importSiteLocalShellyEvidence({}, request),
      () => controller.reviewSavedSiteLocalShellyEvidence('scan-a', request),
      () => controller.reconcileSiteLocalShellyComponent('scan-a', { deviceId: 'x' }, request),
    ]) {
      await expect(Promise.resolve().then(invoke)).rejects.toThrow(UnauthorizedException)
    }
    expect(evidence.importSiteLocalShellyEvidence).not.toHaveBeenCalled()
    expect(evidence.reviewSavedSiteLocalShellyEvidence).not.toHaveBeenCalled()
    expect(evidence.reconcileSiteLocalShellyComponent).not.toHaveBeenCalled()
  })

  it('delegates the original request bodies and scan identifiers without modifying them', async () => {
    const { controller, evidence } = fixture()
    const body = { reportId: 'site-local-report', observerId: 'pi' }
    await expect(controller.importSiteLocalShellyEvidence(body, admin)).resolves.toEqual({ status: 'pending_review' })
    await controller.reviewSavedSiteLocalShellyEvidence('scan-1', admin)
    const selection = { deviceId: 'shellypro2pm-test:switch:0', component: 'switch:0' }
    await controller.reconcileSiteLocalShellyComponent('scan-1', selection, admin)
    expect(evidence.importSiteLocalShellyEvidence).toHaveBeenCalledWith(body)
    expect(evidence.reviewSavedSiteLocalShellyEvidence).toHaveBeenCalledWith('scan-1')
    expect(evidence.reconcileSiteLocalShellyComponent).toHaveBeenCalledWith('scan-1', selection)
  })

  it('scopes saved evidence to the live registry site and rejects absent or foreign-site reports', async () => {
    const { workflow, registry, memory } = workflowFixture()
    await expect(workflow.reviewSavedSiteLocalShellyEvidence('scan-a')).rejects.toThrow(NotFoundException)
    expect(memory.getSnapshot).toHaveBeenCalledWith('scan-a', ownership)

    memory.getSnapshot.mockResolvedValue({ schemaVersion: 2, ownership: { tenantId: ownership.tenantId, siteId: 'foreign' } })
    await expect(workflow.reviewSavedSiteLocalShellyEvidence('scan-foreign')).rejects.toThrow(NotFoundException)
    expect(registry.reconcileShellyIdentityEvidence).not.toHaveBeenCalled()

    registry.getSnapshot.mockReturnValue({ tenant: { id: ownership.tenantId }, site: { id: 'lab', name: 'Lab' } })
    await expect(workflow.reviewSavedSiteLocalShellyEvidence('scan-b')).rejects.toThrow(NotFoundException)
    expect(memory.getSnapshot).toHaveBeenLastCalledWith('scan-b', { tenantId: ownership.tenantId, siteId: 'lab' })
  })

  it('rejects incomplete reconcile selections and missing evidence without registry writes', async () => {
    const { workflow, registry, memory } = workflowFixture()
    await expect(workflow.reconcileSiteLocalShellyComponent('scan-a', { deviceId: 'device-only' }))
      .rejects.toThrow(BadRequestException)
    expect(memory.getSnapshot).not.toHaveBeenCalled()
    await expect(workflow.reconcileSiteLocalShellyComponent('scan-a', { deviceId: 'device', component: 'switch:0' }))
      .rejects.toThrow(NotFoundException)
    expect(memory.getSnapshot).toHaveBeenCalledWith('scan-a', ownership)
    expect(registry.reconcileShellyIdentityEvidence).not.toHaveBeenCalled()
  })
})
