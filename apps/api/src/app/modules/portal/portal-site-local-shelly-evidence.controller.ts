import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { AccessJwtGuard, RequireRoles, RoleGuard } from '../auth/auth.guard'
import type { DeviceProxyRequest } from './portal-device-proxy.service'
import { assertPortalAdministrator } from './portal-authorization'
import { PortalSiteLocalShellyEvidenceWorkflow } from './portal-site-local-shelly-evidence.workflow'

/** Operator-attested read-only RPC evidence ingress, review and explicit reconciliation. */
@ApiExcludeController()
@Controller('portal')
@UseGuards(AccessJwtGuard, RoleGuard)
@RequireRoles('admin')
export class PortalSiteLocalShellyEvidenceController {
  constructor(private readonly evidence: PortalSiteLocalShellyEvidenceWorkflow) {}

  @Post('network/site-local-shelly-evidence')
  importSiteLocalShellyEvidence(@Body() body: unknown, @Req() request: DeviceProxyRequest) {
    assertPortalAdministrator(request)
    return this.evidence.importSiteLocalShellyEvidence(body)
  }

  @Get('network/site-local-shelly-evidence/:scanId/review')
  reviewSavedSiteLocalShellyEvidence(@Param('scanId') scanId: string, @Req() request: DeviceProxyRequest) {
    assertPortalAdministrator(request)
    return this.evidence.reviewSavedSiteLocalShellyEvidence(scanId)
  }

  @Post('network/site-local-shelly-evidence/:scanId/reconcile')
  reconcileSiteLocalShellyComponent(
    @Param('scanId') scanId: string,
    @Body() body: { deviceId?: unknown; component?: unknown },
    @Req() request: DeviceProxyRequest,
  ) {
    assertPortalAdministrator(request)
    return this.evidence.reconcileSiteLocalShellyComponent(scanId, body)
  }
}
