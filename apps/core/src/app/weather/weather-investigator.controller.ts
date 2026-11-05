import {
  BadRequestException,
  ForbiddenException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { WeatherInvestigatorService } from './weather-investigator.service';
import { WeatherInvestigatorScheduler } from './weather-investigator.scheduler';
import { buildWeatherInvestigatorReadiness } from './weather-investigator-readiness';

@Controller('weather/investigator')
export class WeatherInvestigatorController {
  constructor(
    private readonly investigator: WeatherInvestigatorService,
    private readonly scheduler: WeatherInvestigatorScheduler,
  ) {}

  @Get('health')
  async health(
    @Headers('authorization') authorization: string | undefined,
    @Query('siteId') siteId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    this.authorize(authorization);
    const scope = this.requireLabScope(siteId, tenantId);
    const schedule = this.scheduler.snapshot();
    const issue = this.investigator.configurationIssue(scope.siteId, scope.tenantId);
    if (issue) {
      return buildWeatherInvestigatorReadiness(scope, schedule, issue, null, false);
    }
    try {
      const model = await this.investigator.readModel(scope.siteId, scope.tenantId);
      return buildWeatherInvestigatorReadiness(scope, schedule, null, model, false);
    } catch {
      // A missing table/connection is an operator health state, not a leaked SQL 500.
      return buildWeatherInvestigatorReadiness(scope, schedule, null, null, true);
    }
  }

  @Get('findings')
  findings(
    @Headers('authorization') authorization: string | undefined,
    @Query('siteId') siteId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    this.authorize(authorization);
    const scope = this.requireLabScope(siteId, tenantId);
    return this.investigator.list(scope.siteId, scope.tenantId);
  }

  @Get('context')
  context(
    @Headers('authorization') authorization: string | undefined,
    @Query('siteId') siteId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    this.authorize(authorization);
    const scope = this.requireLabScope(siteId, tenantId);
    return this.investigator.context(scope.siteId, scope.tenantId);
  }

  @Get('read-model')
  readModel(
    @Headers('authorization') authorization: string | undefined,
    @Query('siteId') siteId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    this.authorize(authorization);
    const scope = this.requireLabScope(siteId, tenantId);
    return this.investigator.readModel(scope.siteId, scope.tenantId);
  }

  @Post('run')
  async run(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { siteId?: string; tenantId?: string },
  ) {
    this.authorize(authorization);
    const scope = this.requireLabScope(body?.siteId, body?.tenantId);
    try {
      return await this.investigator.run(scope.siteId, scope.tenantId);
    } catch {
      throw new ServiceUnavailableException(
        'Weather investigation could not complete. Check forecast availability and LAB storage.',
      );
    }
  }

  @Post('findings/:id/acknowledge')
  acknowledge(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Body() body: { action?: unknown; siteId?: string; tenantId?: string },
  ) {
    this.authorize(authorization);
    const scope = this.requireLabScope(body?.siteId, body?.tenantId);
    if (body?.action !== 'acknowledged' && body?.action !== 'dismissed')
      throw new BadRequestException('Action must be acknowledged or dismissed');
    return this.investigator.acknowledge(
      id,
      body.action,
      scope.siteId,
      scope.tenantId,
    );
  }

  /**
   * The shared LAB bridge credential is valid for exactly one configured
   * tenant/site pair. A request parameter is not proof of tenant authority.
   * Future multi-site access requires site-bound authenticated principals.
   */
  private requireLabScope(
    siteId?: string,
    tenantId?: string,
  ): { siteId: string; tenantId: string } {
    if (
      typeof siteId !== 'string' ||
      typeof tenantId !== 'string' ||
      !/^[\w.-]{1,120}$/.test(siteId) ||
      !/^[\w.-]{1,120}$/.test(tenantId)
    )
      throw new BadRequestException('Explicit valid tenant and site are required');

    const allowedSite = process.env.WEATHER_INVESTIGATOR_SITE_ID?.trim();
    const allowedTenant = process.env.WEATHER_INVESTIGATOR_TENANT_ID?.trim();
    if (!allowedSite || !allowedTenant)
      throw new ServiceUnavailableException('Weather LAB scope is not configured');
    if (siteId !== allowedSite || tenantId !== allowedTenant)
      throw new ForbiddenException('Weather scope is not authorized');
    return { siteId, tenantId };
  }

  private authorize(authorization?: string) {
    const token = process.env.WEATHER_INVESTIGATOR_API_TOKEN;
    if (process.env.ENERGRID_LAB_MODE !== 'true' || !token || !authorization)
      throw new UnauthorizedException();
    const digest = (value: string) =>
      createHash('sha256').update(value).digest();
    if (!timingSafeEqual(digest(authorization), digest(`Bearer ${token}`)))
      throw new UnauthorizedException();
  }
}
