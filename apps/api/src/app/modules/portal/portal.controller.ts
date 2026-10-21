import {
  All,
  BadRequestException,
  ConflictException,
  Body,
  Controller,
  Get,
  Inject,
  Optional,
  ServiceUnavailableException,
  Header,
  Param,
  Patch,
  Post,
  Req,
  Res,
  Sse,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { map } from 'rxjs'
import { DeviceAiInvestigationService } from '../llm/device-ai-investigation.service'
import type { DeviceInvestigationScope } from '../llm/device-investigation-history.store'
import { DeviceInvestigationWorkflowService } from '../llm/device-investigation-workflow.service'
import { MqttEvidenceCaptureService } from '../devices/mqtt/mqtt-evidence-capture.service'
import { DeviceControlService } from '../devices/device-control.service'
import { DeviceDiagnosticsService } from '../devices/device-diagnostics.service'
import { DeviceDiscoveryMemoryStore } from '../devices/device-discovery-memory.store'
import { DeviceLanDiscoveryService } from '../devices/device-lan-discovery.service'
import { compareNetworkSnapshots } from '../devices/network-discovery-snapshot'
import { DeviceMqttIngestService } from '../devices/device-mqtt-ingest.service'
import { DeviceRegistryService } from '../devices/device-registry.service'
import { DeviceOnboardingService } from './device-onboarding.service'
import { DeviceEnrollmentService } from '../devices/enrollment/device-enrollment.service'
import {
  DEVICE_ENROLLMENT_SERVICE,
  PHYSICAL_DEVICE_INVENTORY_SERVICE,
} from '../devices/enrollment/device-enrollment.module'
import type { PhysicalDeviceInventoryService } from '../devices/enrollment/physical-device-inventory.service'
import type {
  MqttPublisherEvidenceRecord,
  PhysicalDeviceInventoryRecord,
} from '../devices/enrollment/physical-device-inventory.repository'
import { projectPendingDeviceIdentity } from './pending-device-identity.projection'
import { shellyLanCandidates } from '../devices/adapters/inbound/shelly/shelly-lan-candidates'
import {
  type DeviceProxyRequest,
  type DeviceProxyResponse,
  PortalDeviceProxyService,
} from './portal-device-proxy.service'
import { PortalStateService } from './portal-state.service'

type DisconnectAwareResponse = {
  writableEnded: boolean;
  once(event: 'close', listener: () => void): unknown;
  off(event: 'close', listener: () => void): unknown;
};

@ApiExcludeController()
@Controller('portal')
export class PortalController {
  constructor(
    private readonly stateService: PortalStateService,
    private readonly lanDiscovery: DeviceLanDiscoveryService,
    private readonly deviceProxy: PortalDeviceProxyService,
    private readonly deviceControl: DeviceControlService,
    private readonly mqttIngest: DeviceMqttIngestService,
    private readonly deviceRegistry: DeviceRegistryService,
    private readonly diagnostics: DeviceDiagnosticsService,
    private readonly deviceAi: DeviceAiInvestigationService,
    private readonly investigationWorkflow: DeviceInvestigationWorkflowService,
    private readonly mqttEvidence: MqttEvidenceCaptureService,
    private readonly discoveryMemory: DeviceDiscoveryMemoryStore,
    @Optional()
    @Inject(DEVICE_ENROLLMENT_SERVICE)
    private readonly enrollment?: DeviceEnrollmentService,
    @Optional()
    private readonly onboarding?: DeviceOnboardingService,
    @Optional()
    @Inject(PHYSICAL_DEVICE_INVENTORY_SERVICE)
    private readonly physicalInventory?: PhysicalDeviceInventoryService,
  ) {}

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  getPortal(): string {
    return portalHtml()
  }

  @Get('state')
  async getState(@Req() request: DeviceProxyRequest) {
    assertPortalControlToken(request)
    const state = this.stateService.getState()
    const { tenant, site } = this.deviceRegistry.getSnapshot()
    const pending = (state.devices ?? []).filter(device =>
      device.trustStatus === 'discovered' &&
      device.tenantId === tenant.id &&
      device.siteId === site.id,
    )
    const networkHistory = await this.discoveryMemory.listIdentityEvidence().catch(() => [])
    let inventory: PhysicalDeviceInventoryRecord[] = []
    let brokerEvidence: MqttPublisherEvidenceRecord[] = []
    let inventoryAvailable = !!this.physicalInventory
    if (this.physicalInventory) {
      try {
        inventory = await this.physicalInventory.list({ tenantId: tenant.id, siteId: site.id })
      } catch {
        inventoryAvailable = false
      }
      try {
        brokerEvidence = await this.physicalInventory.listRecentMqttPublisherEvidence({
          tenantId: tenant.id, siteId: site.id,
        })
      } catch {
        // Attribution is optional until its additive migration is deployed.
      }
    }
    const pendingDeviceIdentities = Object.fromEntries(pending.map(device => [
      device.id,
      projectPendingDeviceIdentity(
        device,
        inventory,
        [...this.lanDiscovery.getLastScan(), ...networkHistory.map(record => record.device)],
        inventoryAvailable,
        networkHistory,
        Date.now,
        brokerEvidence,
      ),
    ]))
    return { ...state, pendingDeviceIdentities }
  }


  @Get('devices/enrollments')
  async listDeviceEnrollments(@Req() request: DeviceProxyRequest) {
    assertPortalControlToken(request)

    if (!this.enrollment) {
      throw new ServiceUnavailableException(
        'Device enrollment repository is unavailable',
      )
    }

    const { tenant, site } = this.deviceRegistry.getSnapshot()

    return {
      enrollments: await this.enrollment.list({
        tenantId: tenant.id,
        siteId: site.id,
      }),
    }
  }

  @Get('devices/:deviceId/network-identity')
  async getDeviceNetworkIdentity(
    @Param('deviceId') deviceId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)
    if (!this.enrollment || !this.physicalInventory) {
      throw new ServiceUnavailableException('Device identity service is unavailable')
    }
    const { tenant, site } = this.deviceRegistry.getSnapshot()
    const scope = { tenantId: tenant.id, siteId: site.id }
    const enrollment = await this.enrollment.find({ ...scope, deviceId })
    if (!enrollment) {
      throw new NotFoundException('Enrolled device was not found')
    }
    const physicalDevice = await this.physicalInventory.forLogicalDevice(scope, deviceId)
    const history = physicalDevice?.networkObservations ?? []
    const current = history.find(item => item.isCurrent) ?? null
    const logicalAssignment = physicalDevice?.assignments.find(
      item => item.deviceId === deviceId,
    ) ?? null
    const association = current ? {
      ...current,
      networkZoneId: current.networkScope,
      networkZoneName: current.networkScope,
      observedAt: current.observedAt,
      evidenceSource: current.evidenceSource,
      verificationStatus: current.verificationStatus,
    } : null
    return {
      logicalDeviceId: deviceId,
      logicalAssignment,
      association,
      history,
      physicalDevice,
    }
  }

  @Post('devices/:deviceId/component-assignment')
  async assignDeviceComponent(
    @Param('deviceId') deviceId: string,
    @Body() body: { physicalDeviceId?: unknown; componentKey?: unknown; role?: unknown },
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)
    if (!this.enrollment || !this.physicalInventory) {
      throw new ServiceUnavailableException('Device identity service is unavailable')
    }
    if (typeof body?.physicalDeviceId !== 'string' || !body.physicalDeviceId.trim() ||
      (body.componentKey !== undefined && typeof body.componentKey !== 'string') ||
      (body.role !== undefined && typeof body.role !== 'string')) {
      throw new BadRequestException('Physical device assignment is invalid')
    }
    const { tenant, site } = this.deviceRegistry.getSnapshot()
    const current = await this.physicalInventory.forLogicalDevice(
      { tenantId: tenant.id, siteId: site.id }, deviceId,
    )
    const assignment = current?.assignments.find(item => item.deviceId === deviceId)
    if (!assignment || assignment.physicalDeviceId !== body.physicalDeviceId ||
      (assignment.componentKey ?? '') !== (typeof body.componentKey === 'string' ? body.componentKey : '')) {
      throw new ConflictException('Physical identity assignments are managed by protocol discovery')
    }
    const physicalDevice = await this.physicalInventory.assignComponent({
      device: { tenantId: tenant.id, siteId: site.id, deviceId },
      physicalDeviceId: body.physicalDeviceId,
      ...(typeof body.componentKey === 'string' && body.componentKey.trim() ? { componentKey: body.componentKey } : {}),
      ...(typeof body.role === 'string' && body.role.trim() ? { role: body.role } : {}),
      actor: 'portal-control-token',
    })
    return { physicalDevice }
  }

  @Post('network/scan')
  async scanNetwork(
    @Body() body: { scopeIds?: unknown; fullSubnetConfirmed?: unknown },
    @Req() request: DeviceProxyRequest,
    @Res({ passthrough: true }) response?: DisconnectAwareResponse,
  ) {
    assertPortalControlToken(request)
    if (!Array.isArray(body?.scopeIds) || body.scopeIds.length === 0 ||
      body.scopeIds.some(id => typeof id !== 'string' || !id.trim()) ||
      typeof body.fullSubnetConfirmed !== 'boolean') {
      throw new BadRequestException('Choose network scopes and explicitly confirm any full-subnet scan')
    }
    const configured = this.lanDiscovery.getZones()
    const selected = configured.filter(zone => (body.scopeIds as string[]).includes(zone.id))
    if (selected.length !== new Set(body.scopeIds as string[]).size) {
      throw new BadRequestException('One or more selected network scopes are not configured')
    }
    if (selected.some(zone => zone.cidr) && body.fullSubnetConfirmed !== true) {
      throw new BadRequestException('Full-subnet discovery requires explicit operator confirmation')
    }
    const controller = new AbortController()
    const abortIfDisconnected = () => {
      if (response && !response.writableEnded) controller.abort()
    }
    response?.once('close', abortIfDisconnected)
    let scan: Awaited<ReturnType<DeviceLanDiscoveryService['scanNow']>>
    try {
      scan = await this.lanDiscovery.scanNow({
        scopeIds: body.scopeIds as string[],
        fullSubnetConfirmed: body.fullSubnetConfirmed,
        signal: controller.signal,
      })
    } finally {
      response?.off('close', abortIfDisconnected)
    }
    for (const device of scan.devices) {
      for (const candidate of shellyLanCandidates(device))
        this.deviceRegistry.registerDiscoveredDevice(candidate)
    }
    return scan
  }

  @Get('network/snapshots')
  async listNetworkSnapshots(@Req() request: DeviceProxyRequest) {
    assertPortalControlToken(request)
    return { snapshots: await this.discoveryMemory.listSnapshots(50) }
  }

  @Get('network/capabilities')
  async networkCapabilities(@Req() request: DeviceProxyRequest) {
    assertPortalControlToken(request)
    return { nmap: await this.lanDiscovery.getNmapCapability() }
  }

  @Get('network/snapshots/:fromScanId/compare/:toScanId')
  async compareNetworkSnapshotRoute(
    @Param('fromScanId') fromScanId: string,
    @Param('toScanId') toScanId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)
    const [previous, current] = await Promise.all([
      this.discoveryMemory.getSnapshot(fromScanId),
      this.discoveryMemory.getSnapshot(toScanId),
    ])
    if (!previous || !current) throw new NotFoundException('Network discovery snapshot was not found')
    return compareNetworkSnapshots(previous, current)
  }

  @Get('network/memory')
  async getNetworkDiscoveryMemory(@Req() request: DeviceProxyRequest) {
    assertPortalControlToken(request)

    const [devices, summary] = await Promise.all([
      this.discoveryMemory.list(),
      this.discoveryMemory.summary(),
    ])

    return { summary, devices }
  }

  @Get('network/memory/summary')
  async getNetworkDiscoveryMemorySummary(
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)
    return this.discoveryMemory.summary()
  }

  @Post('network/:deviceId/investigate')
  async investigateNetworkDeviceWithAi(
    @Param('deviceId') deviceId: string,
    @Body() body: { cloudDataConsent?: unknown },
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)

    const device = await this.resolveInvestigationTarget(deviceId)
    const scope = this.investigationScope(device)
    return this.deviceAi.investigate(
      scope,
      deviceId,
      [device],
      body?.cloudDataConsent === true,
    )
  }

  @Post('network/:deviceId/investigations/:investigationId/actions/:proposalId/execute')
  async executeInvestigationAction(
    @Param('deviceId') deviceId: string,
    @Param('investigationId') investigationId: string,
    @Param('proposalId') proposalId: string,
    @Body() body: { approved?: unknown; cloudDataConsent?: unknown },
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)
    const target = await this.resolveInvestigationTarget(deviceId)
    const scope = this.investigationScope(target)
    return this.investigationWorkflow.executeProposedAction({
      scope,
      deviceId,
      investigationId,
      proposalId,
      target,
      zones: this.lanDiscovery.getZones(),
      approved: body?.approved === true,
      cloudDataConsent: body?.cloudDataConsent === true,
    })
  }

  @Post('network/:deviceId/profile-investigations')
  async investigateNetworkMqttProfile(
    @Param('deviceId') deviceId: string,
    @Body() body: { cloudDataConsent?: unknown },
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)

    const { tenant, site } = this.deviceRegistry.getSnapshot()

    return this.deviceAi.investigateStoredMqttProfile(
      { tenantId: tenant.id, siteId: site.id },
      deviceId,
      body?.cloudDataConsent === true,
    )
  }

  @Get('network/:deviceId/profile-investigations')
  async listNetworkMqttProfiles(
    @Param('deviceId') deviceId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)

    const { tenant, site } = this.deviceRegistry.getSnapshot()

    return this.deviceAi.listMqttProfileInvestigations(
      { tenantId: tenant.id, siteId: site.id },
      deviceId,
      50,
    )
  }

  @Get('investigations/availability')
  getInvestigationAvailability(@Req() request: DeviceProxyRequest) {
    assertPortalControlToken(request)
    return this.deviceAi.getProviderAvailability()
  }

  @Get('network/:deviceId/profile-investigations/:investigationId')
  async getNetworkMqttProfile(
    @Param('deviceId') deviceId: string,
    @Param('investigationId') investigationId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)

    const { tenant, site } = this.deviceRegistry.getSnapshot()

    return this.deviceAi.getMqttProfileInvestigation(
      { tenantId: tenant.id, siteId: site.id },
      deviceId,
      investigationId,
    )
  }

  @Get('network/:deviceId/investigations')
  async listNetworkDeviceInvestigations(
    @Param('deviceId') deviceId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)
    const device = await this.resolveInvestigationTarget(deviceId)
    return this.deviceAi.listHistory(this.investigationScope(device), deviceId, 50)
  }

  @Get('network/:deviceId/investigations/:investigationId')
  async getNetworkDeviceInvestigation(
    @Param('deviceId') deviceId: string,
    @Param('investigationId') investigationId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)
    const device = await this.resolveInvestigationTarget(deviceId)
    return this.deviceAi.getHistoryRecord(this.investigationScope(device), deviceId, investigationId)
  }

  private async resolveInvestigationTarget(deviceId: string) {
    const live = this.lanDiscovery.getLastScan().find(device => device.id === deviceId)
    if (live) return live
    const remembered = (await this.discoveryMemory.list())
      .find(record => record.device.id === deviceId)
    if (remembered) return remembered.device
    throw new NotFoundException('Discovered device not found in this site')
  }

  private investigationScope(device: {
    id: string
    networkZoneId: string
    gatewayId?: string
  }): DeviceInvestigationScope {
    const { tenant, site } = this.deviceRegistry.getSnapshot()
    return {
      tenantId: tenant.id,
      siteId: site.id,
      networkId: `${device.gatewayId || 'gateway-unknown'}:${device.networkZoneId}`,
    }
  }

  @Get('mqtt/evidence/:deviceId/status')
  async getKitchenMqttEvidenceStatus(
    @Param('deviceId') deviceId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)

    const { tenant, site } = this.deviceRegistry.getSnapshot()

    return this.mqttEvidence.getCaptureStatus(
      { tenantId: tenant.id, siteId: site.id },
      deviceId,
    )
  }

  @Get('bus/mqtt')
  getMqttBus(@Req() request: DeviceProxyRequest) {
    assertPortalControlToken(request)
    return this.mqttIngest.getDebugState()
  }

  @Sse('bus/mqtt/events')
  streamMqttBus(@Req() request: DeviceProxyRequest) {
    assertPortalControlToken(request)
    return this.mqttIngest.streamDebugMessages().pipe(
      map((message) => ({
        type: 'mqtt_message',
        data: message,
      })),
    )
  }

  @Post('bus/mqtt/publish')
  publishMqtt(
    @Body() body: { topic?: string; payload?: unknown },
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)
    return this.mqttIngest.publishDebugMessage(body?.topic, body?.payload)
  }

  @Post('devices/:deviceId/actions')
  async executeDeviceAction(
    @Param('deviceId') deviceId: string,
    @Body() body: { action?: string },
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)
    await this.deviceRegistry.persistInstallationEvent(deviceId, 'command', {
      action: body?.action || '',
      stage: 'requested',
      status: 'requested',
    })
    let result: Awaited<ReturnType<DeviceControlService['execute']>>
    try {
      result = await this.deviceControl.execute(deviceId, body?.action)
    } catch (error) {
      await this.deviceRegistry.persistInstallationEvent(deviceId, 'command', {
        action: body?.action || '',
        stage: 'result',
        status: 'failed',
        failureType: error instanceof Error ? error.name : 'UnknownError',
        message: 'The command did not complete successfully.',
      })
      throw error
    }
    await this.deviceRegistry.persistInstallationEvent(deviceId, 'command', {
      action: result.action,
      stage: 'result',
      status: result.status,
      adapter: result.adapter,
      commandId: result.command?.id || '',
      message: result.message,
    })
    return result
  }

  @Post('devices/:deviceId/retire')
  async retireDevice(
    @Param('deviceId') deviceId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)
    if (!this.enrollment) {
      throw new ServiceUnavailableException('Device enrollment service is unavailable')
    }
    const { tenant, site } = this.deviceRegistry.getSnapshot()
    const identity = { tenantId: tenant.id, siteId: site.id, deviceId }
    const current = await this.enrollment.find(identity)
    if (!current) throw new NotFoundException('Enrolled device was not found')
    if (current.status === 'retired') {
      throw new ConflictException('Device is already retired')
    }
    const enrollment = await this.enrollment.retire(identity, 'portal-control-token')
    this.deviceRegistry.setEnrollmentStatus(deviceId, 'retired')
    return { status: 'retired', enrollment }
  }

  @Post('devices/:deviceId/reenroll')
  async reenrollDevice(
    @Param('deviceId') deviceId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)
    if (!this.enrollment) {
      throw new ServiceUnavailableException('Device enrollment service is unavailable')
    }
    const { tenant, site } = this.deviceRegistry.getSnapshot()
    const identity = { tenantId: tenant.id, siteId: site.id, deviceId }
    const current = await this.enrollment.find(identity)
    if (!current) throw new NotFoundException('Enrolled device was not found')
    if (current.status !== 'retired') {
      throw new ConflictException('Only a retired device can be explicitly reenrolled')
    }
    const device = this.deviceRegistry.getDevices().find(item =>
      item.id === deviceId && item.tenantId === tenant.id && item.siteId === site.id,
    )
    if (!device || device.trustStatus !== 'approved') {
      throw new ConflictException('Previously approved hardware is required for reenrollment')
    }
    const enrollment = await this.enrollment.reenroll(
      identity,
      current.displayName,
      'portal-control-token',
    )
    this.deviceRegistry.setEnrollmentStatus(deviceId, 'enrolled')
    return { status: 'enrolled', enrollment }
  }

  @Post('devices/:deviceId/control')
  async configureDeviceControl(
    @Param('deviceId') deviceId: string,
    @Body() body: { binding?: unknown },
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)
    const previousBinding = this.deviceRegistry.getDevices()
      .find((item) => item.id === deviceId)?.control?.binding || null
    const device = this.deviceControl.configure(deviceId, body?.binding ?? null)
    try {
      await this.deviceRegistry.persistInstallation(device)
    } catch (error) {
      this.deviceControl.configure(deviceId, previousBinding)
      throw error
    }
    await this.deviceRegistry.persistInstallationEvent(deviceId, 'control_configured', {
      route: device.control?.binding?.kind || 'none',
      enabled: device.control?.binding?.enabled || false,
    })
    return { device, persistence: 'local' }
  }

  @Post('devices/:deviceId/diagnostics')
  checkDeviceConnection(
    @Param('deviceId') deviceId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)
    return this.diagnostics.check(deviceId)
  }

  @Post('discovery/:deviceId/approve')
  async approveDiscoveredDevice(
    @Param('deviceId') deviceId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)
    if (!this.onboarding) {
      throw new ServiceUnavailableException(
        'Device onboarding is unavailable',
      )
    }

    const device = await this.onboarding.approve(deviceId)

    return {
      status: 'approved',
      enrollment: 'enrolled',
      device,
    }
  }

  @Post('devices/:deviceId/commissioning/confirm-physical-outcome')
  async confirmPhysicalOutcome(
    @Param('deviceId') deviceId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)
    const device = this.deviceRegistry.getDevices().find((item) => item.id === deviceId)
    if (!device || device.trustStatus !== 'approved')
      throw new NotFoundException(`Approved device ${deviceId} was not found.`)
    let updated
    try {
      updated = await this.deviceRegistry.confirmPhysicalOutcome(deviceId)
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Physical result could not be confirmed.')
    }
    return { status: 'confirmed', device: updated }
  }

  @Patch('devices/:deviceId/commissioning')
  async updateCommissioningDetails(
    @Param('deviceId') deviceId: string,
    @Body() body: { displayName?: string; zoneName?: string; assistantEnabled?: boolean; settingsUrl?: string | null },
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)
    const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : ''
    const zoneName = typeof body?.zoneName === 'string' ? body.zoneName.trim() : ''
    if (!displayName || displayName.length > 100 || !zoneName || zoneName.length > 80)
      throw new BadRequestException('Enter a device name and room name within the allowed length.')
    let device
    try {
      device = await this.deviceRegistry.updateInstallationDetails(
        deviceId,
        displayName,
        zoneName,
        typeof body.assistantEnabled === 'boolean' ? body.assistantEnabled : undefined,
        typeof body.settingsUrl === 'string' || body.settingsUrl === null ? body.settingsUrl : undefined,
      )
      await this.deviceRegistry.persistInstallationEvent(deviceId, 'installation_details_saved', {
        displayName,
        zoneName,
        assistantEnabled: device.assistantEnabled === true,
        settingsAddressConfigured: typeof body.settingsUrl === 'string' && !!body.settingsUrl.trim(),
        update: 'installation_details',
      })
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Installation details could not be saved.')
    }
    return { device, persistence: 'local' }
  }

  @Get('devices/:deviceId/commissioning/events')
  async getCommissioningEvents(
    @Param('deviceId') deviceId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)
    const device = this.deviceRegistry.getDevices().find((item) => item.id === deviceId)
    if (!device || device.trustStatus !== 'approved')
      throw new NotFoundException(`Approved device ${deviceId} was not found.`)
    return { deviceId, events: await this.deviceRegistry.getInstallationEvents(deviceId) }
  }

  @Post('discovery/:deviceId/block')
  blockDiscoveredDevice(
    @Param('deviceId') deviceId: string,
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalControlToken(request)
    const blocked = this.deviceRegistry.blockDiscoveredDevice(deviceId)
    if (!blocked) {
      throw new NotFoundException(`Discovered device ${deviceId} was not found.`)
    }
    return { status: 'blocked', deviceId }
  }

  @All('device-proxy/:deviceId')
  proxyDeviceRoot(
    @Param('deviceId') deviceId: string,
    @Req() request: DeviceProxyRequest,
    @Res() response: DeviceProxyResponse,
  ) {
    return this.deviceProxy.proxy(deviceId, '/', request, response)
  }

  @All('device-proxy/:deviceId/*proxyPath')
  proxyDevicePath(
    @Param('deviceId') deviceId: string,
    @Param('proxyPath') proxyPath: string | string[],
    @Req() request: DeviceProxyRequest,
    @Res() response: DeviceProxyResponse,
  ) {
    const path = Array.isArray(proxyPath) ? proxyPath.join('/') : proxyPath
    return this.deviceProxy.proxy(deviceId, path, request, response)
  }
}

export function assertPortalControlToken(request: DeviceProxyRequest): void {
  const expected = process.env.PORTAL_CONTROL_TOKEN ||
    (process.env.NODE_ENV === 'production' ? '' : 'dev-token-admin')
  const authorization = request.headers.authorization
  const headerToken = Array.isArray(authorization)
    ? authorization[0]
    : authorization
  if (!expected || headerToken !== `Bearer ${expected}`) {
    throw new UnauthorizedException('Device control requires portal authorization.')
  }
}

function portalHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Energrid Portal</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #101314; color: #eef4f3; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #101314; }
    button, input { font: inherit; }
    button { border: 0; border-radius: 6px; padding: 10px 13px; background: #24c58f; color: #061311; font-weight: 800; cursor: pointer; }
    button.secondary { background: #334144; color: #eef4f3; }
    button.ghost { background: transparent; color: #9ddfc9; border: 1px solid #31504a; }
    button:disabled { opacity: .45; cursor: not-allowed; }
    input { width: 100%; border: 1px solid #344143; border-radius: 6px; padding: 10px 11px; background: #171f21; color: #eef4f3; }
    label { display: block; margin: 0 0 6px; color: #a9b9b8; font-size: 13px; }
    .shell { max-width: 1180px; margin: 0 auto; padding: 22px 18px 36px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 20px; }
    .brand { display: flex; flex-direction: column; gap: 2px; }
    .brand strong { font-size: 22px; letter-spacing: 0; }
    .brand span, .muted { color: #9aa8a8; }
    .login { max-width: 390px; margin: 14vh auto 0; border: 1px solid #2d393b; border-radius: 8px; padding: 20px; background: #151b1d; }
    .login h1 { margin: 0 0 18px; font-size: 26px; }
    .field { margin-bottom: 13px; }
    .error { color: #ff9f9f; min-height: 22px; margin-top: 10px; }
    .hidden { display: none !important; }
    .grid { display: grid; grid-template-columns: 330px 1fr; gap: 16px; align-items: start; }
    .panel { border: 1px solid #2d393b; border-radius: 8px; background: #151b1d; padding: 14px; }
    .stack { display: grid; gap: 16px; }
    .section-title { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 10px; }
    .section-title h2 { margin: 0; font-size: 16px; }
    .sensor-value { font-size: 42px; line-height: 1; font-weight: 850; margin: 6px 0; }
    .sensor-meta { color: #9aa8a8; font-size: 13px; }
    .status { color: #9ddfc9; font-weight: 800; }
    .voice-row { display: flex; flex-wrap: wrap; gap: 9px; align-items: center; margin: 10px 0; }
    .voice-url { min-width: 260px; flex: 1; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0 0; color: #e6eeee; }
    .events { max-height: 260px; overflow: auto; font-size: 12px; }
    .metric { display: inline-block; margin: 4px 8px 4px 0; color: #c8d7d7; }
    .plan { min-height: 72px; }
    @media (max-width: 820px) { .grid { grid-template-columns: 1fr; } .topbar { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>
  <main class="shell">
    <section id="loginView" class="login">
      <h1>Energrid Portal</h1>
      <div class="field">
        <label for="email">Email</label>
        <input id="email" autocomplete="username" />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" autocomplete="current-password" type="password" />
      </div>
      <button id="loginBtn">Sign In</button>
      <div id="loginError" class="error"></div>
    </section>

    <section id="portalView" class="hidden">
      <header class="topbar">
        <div class="brand">
          <strong>Energrid Portal</strong>
          <span id="siteLabel">Loading...</span>
        </div>
        <div>
          <span id="userLabel" class="muted"></span>
          <button id="refreshBtn" class="ghost">Refresh</button>
          <button id="logoutBtn" class="secondary">Sign Out</button>
        </div>
      </header>

      <div class="grid">
        <aside class="stack">
          <section class="panel">
            <div class="section-title">
              <h2>Kitchen</h2>
              <span id="sensorSource" class="muted"></span>
            </div>
            <div id="kitchenTemp" class="sensor-value">--</div>
            <div id="kitchenObserved" class="sensor-meta">--</div>
          </section>
          <section class="panel">
            <div class="section-title">
              <h2>Runtime</h2>
            </div>
            <div>STT: <span id="sttProvider" class="status">--</span></div>
            <div>Voice: <span id="voiceState" class="status">idle</span></div>
          </section>
        </aside>

        <section class="stack">
          <section class="panel">
            <div class="section-title">
              <h2>Assistant</h2>
              <span id="secureWarning" class="muted" hidden>Microphone needs HTTPS or localhost.</span>
            </div>
            <label for="wsUrl">Voice WebSocket</label>
            <div class="voice-row">
              <input id="wsUrl" class="voice-url" autocomplete="off" />
              <button id="connectBtn">Connect</button>
              <button id="recordBtn" disabled>Hold To Talk</button>
              <button id="disconnectBtn" class="secondary" disabled>Disconnect</button>
            </div>
            <pre id="transcript"></pre>
            <pre id="assistant"></pre>
          </section>

          <section class="panel">
            <div class="section-title"><h2>Plan</h2></div>
            <pre id="plan" class="plan"></pre>
          </section>

          <section class="panel">
            <div class="section-title"><h2>Metrics</h2></div>
            <div id="metrics"></div>
          </section>

          <section class="panel events">
            <div class="section-title"><h2>Events</h2></div>
            <pre id="events"></pre>
          </section>
        </section>
      </div>
    </section>
  </main>

  <script>
    const SAMPLE_RATE = 16000
    const FLUSH_SAMPLES = 4096
    const tokenKey = 'energrid.portal.token'
    const userKey = 'energrid.portal.user'

    const els = Object.fromEntries([
      'loginView','portalView','email','password','loginBtn','loginError','siteLabel','userLabel','refreshBtn','logoutBtn','kitchenTemp','kitchenObserved','sensorSource','sttProvider','voiceState','secureWarning','wsUrl','connectBtn','recordBtn','disconnectBtn','transcript','assistant','plan','metrics','events'
    ].map((id) => [id, document.getElementById(id)]))

    let ws = null
    let audioContext = null
    let mediaStream = null
    let source = null
    let processor = null
    let pcmQueue = []
    let recording = false
    let voiceAuthenticated = false

    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    els.wsUrl.value = wsProtocol + '//' + location.host + '/voice'
    els.secureWarning.hidden = window.isSecureContext

    function showPortal(user) {
      els.loginView.classList.add('hidden')
      els.portalView.classList.remove('hidden')
      els.userLabel.textContent = user?.name || user?.email || ''
      loadState()
    }

    function showLogin() {
      els.portalView.classList.add('hidden')
      els.loginView.classList.remove('hidden')
    }

    async function login() {
      els.loginError.textContent = ''
      const response = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: els.email.value,
          password: els.password.value,
        }),
      })

      if (!response.ok) {
        els.loginError.textContent = 'Invalid credentials'
        return
      }

      const data = await response.json()
      localStorage.setItem(tokenKey, data.accessToken)
      localStorage.setItem(userKey, JSON.stringify(data.user))
      showPortal(data.user)
    }

    async function loadState() {
      const response = await fetch('/portal/state', {
        headers: { Authorization: 'Bearer ' + localStorage.getItem(tokenKey) },
      })
      const state = await response.json()
      const kitchen = state.zones.find((zone) => zone.id === 'kitchen')
      const temp = kitchen?.sensors.find((sensor) => sensor.id === 'kitchen-temperature')
      els.siteLabel.textContent = state.tenant.name + ' / ' + state.site.name + ' / ' + state.site.mode
      els.kitchenTemp.textContent = temp?.value == null ? '--' : temp.value.toFixed(1) + '°C'
      els.kitchenObserved.textContent = temp?.observedAt ? 'Observed ' + new Date(temp.observedAt).toLocaleTimeString() : '--'
      els.sensorSource.textContent = temp?.source || ''
      els.sttProvider.textContent = state.voice.provider
    }

    function setVoiceState(value) {
      els.voiceState.textContent = value
    }

    function resetTurnUi() {
      els.transcript.textContent = ''
      els.assistant.textContent = ''
      els.plan.textContent = ''
      els.metrics.textContent = ''
      els.events.textContent = ''
    }

    function logEvent(event) {
      els.events.textContent += JSON.stringify(event) + '\\n'
      els.events.scrollTop = els.events.scrollHeight
    }

    function connectVoice() {
      resetTurnUi()
      ws = new WebSocket(els.wsUrl.value)
      ws.binaryType = 'arraybuffer'
      setVoiceState('connecting')
      ws.addEventListener('open', () => {
        setVoiceState('authenticating')
        els.connectBtn.disabled = true
        els.disconnectBtn.disabled = false
        ws.send(JSON.stringify({
          type: 'authenticate',
          token: localStorage.getItem(tokenKey) || '',
        }))
      })
      ws.addEventListener('close', () => {
        setVoiceState('closed')
        voiceAuthenticated = false
        els.connectBtn.disabled = false
        els.disconnectBtn.disabled = true
        els.recordBtn.disabled = true
        ws = null
      })
      ws.addEventListener('error', () => setVoiceState('socket error'))
      ws.addEventListener('message', (message) => {
        const event = JSON.parse(message.data)
        logEvent(redactAudio(event))
        if (event.type === 'authenticated') {
          voiceAuthenticated = true
          setVoiceState('connected')
          els.recordBtn.disabled = false
        }
        if (event.type === 'stt_final') els.transcript.textContent = event.full || event.text || ''
        if (event.type === 'assistant_text_delta') els.assistant.textContent = event.full || ''
        if (event.type === 'assistant_final') els.assistant.textContent = event.text || ''
        if (event.type === 'home_action_plan') els.plan.textContent = JSON.stringify(event.plan, null, 2)
        if (event.type === 'assistant_audio_chunk') playAudioBase64(event.audioBase64, event.format)
        if (event.type === 'turn_end') renderMetrics(event.metrics)
        if (event.type === 'error') setVoiceState('error: ' + event.message)
      })
    }

    function redactAudio(event) {
      if (event.type !== 'assistant_audio_chunk') return event
      return { ...event, audioBase64: '<' + Math.round((event.audioBase64 || '').length / 1024) + 'KB base64>' }
    }

    function renderMetrics(metrics) {
      if (!metrics) return
      const keys = ['totalMs', 'sttMs', 'llmFirstDeltaMs', 'firstAudioMs', 'firstTtsDurationMs', 'ttsTotalMs', 'assistantCompleteMs', 'chunkCount', 'commandFastPath', 'speechGatePassed', 'audioRmsDb', 'audioPeakDb']
      els.metrics.innerHTML = keys.map((key) => '<span class="metric">' + key + ': ' + (metrics[key] ?? '-') + '</span>').join('')
      setVoiceState('turn complete')
    }

    async function startRecording() {
      if (!voiceAuthenticated || !ws || ws.readyState !== WebSocket.OPEN) return
      resetTurnUi()
      pcmQueue = []
      recording = true
      els.recordBtn.textContent = 'Release To Send'
      setVoiceState('recording')
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      audioContext = new AudioContext()
      source = audioContext.createMediaStreamSource(mediaStream)
      processor = audioContext.createScriptProcessor(4096, 1, 1)
      processor.onaudioprocess = (event) => {
        if (!recording || !ws || ws.readyState !== WebSocket.OPEN) return
        const input = event.inputBuffer.getChannelData(0)
        const pcm16 = resampleToPcm16(input, audioContext.sampleRate, SAMPLE_RATE)
        enqueueAndFlush(pcm16)
      }
      source.connect(processor)
      processor.connect(audioContext.destination)
    }

    async function stopRecording() {
      if (!recording) return
      recording = false
      els.recordBtn.textContent = 'Hold To Talk'
      setVoiceState('sending')
      flushPcm(true)
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'end_of_turn' }))
      await cleanupAudio()
    }

    function enqueueAndFlush(pcm16) {
      for (let i = 0; i < pcm16.length; i += 1) pcmQueue.push(pcm16[i])
      flushPcm(false)
    }

    function flushPcm(force) {
      while (pcmQueue.length >= FLUSH_SAMPLES || (force && pcmQueue.length > 0)) {
        const size = force ? pcmQueue.length : FLUSH_SAMPLES
        const chunk = new Int16Array(pcmQueue.splice(0, size))
        ws.send(chunk.buffer)
      }
    }

    function resampleToPcm16(input, inputRate, outputRate) {
      if (inputRate === outputRate) return floatToPcm16(input)
      const ratio = inputRate / outputRate
      const outputLength = Math.floor(input.length / ratio)
      const output = new Float32Array(outputLength)
      for (let i = 0; i < outputLength; i += 1) {
        output[i] = input[Math.min(input.length - 1, Math.floor(i * ratio))]
      }
      return floatToPcm16(output)
    }

    function floatToPcm16(input) {
      const output = new Int16Array(input.length)
      for (let i = 0; i < input.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, input[i]))
        output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      }
      return output
    }

    async function cleanupAudio() {
      if (processor) processor.disconnect()
      if (source) source.disconnect()
      if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop())
      if (audioContext) await audioContext.close()
      processor = null
      source = null
      mediaStream = null
      audioContext = null
    }

    function playAudioBase64(base64, format) {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const blob = new Blob([bytes], { type: 'audio/' + (format || 'wav') })
      const audio = new Audio(URL.createObjectURL(blob))
      audio.play().catch(() => undefined)
    }

    els.loginBtn.addEventListener('click', login)
    els.password.addEventListener('keydown', (event) => { if (event.key === 'Enter') login() })
    els.refreshBtn.addEventListener('click', loadState)
    els.logoutBtn.addEventListener('click', () => {
      localStorage.removeItem(tokenKey)
      localStorage.removeItem(userKey)
      ws?.close()
      showLogin()
    })
    els.connectBtn.addEventListener('click', connectVoice)
    els.disconnectBtn.addEventListener('click', () => ws?.close())
    els.recordBtn.addEventListener('pointerdown', startRecording)
    els.recordBtn.addEventListener('pointerup', stopRecording)
    els.recordBtn.addEventListener('pointercancel', stopRecording)

    const savedUser = localStorage.getItem(userKey)
    if (localStorage.getItem(tokenKey) && savedUser) {
      showPortal(JSON.parse(savedUser))
    } else {
      showLogin()
    }
  </script>
</body>
</html>`
}
