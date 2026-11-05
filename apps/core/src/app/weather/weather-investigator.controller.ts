import {
  BadRequestException,
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

@Controller('weather/investigator')
export class WeatherInvestigatorController {
  constructor(private readonly investigator: WeatherInvestigatorService) {}

  @Get('findings')
  findings(
    @Headers('authorization') authorization: string | undefined,
    @Query('siteId') siteId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    this.authorize(authorization);
    return this.investigator.list(siteId, tenantId);
  }

  @Get('context')
  context(
    @Headers('authorization') authorization: string | undefined,
    @Query('siteId') siteId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    this.authorize(authorization);
    return this.investigator.context(siteId, tenantId);
  }

  @Get('read-model')
  readModel(
    @Headers('authorization') authorization: string | undefined,
    @Query('siteId') siteId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    this.authorize(authorization);
    // Never silently default to the LAB site in a site-scoped read boundary.
    if (!siteId || !tenantId ||
        !/^[\w.-]{1,120}$/.test(siteId) || !/^[\w.-]{1,120}$/.test(tenantId))
      throw new BadRequestException('Explicit tenant and site are required');
    return this.investigator.readModel(siteId, tenantId);
  }

  @Post('run')
  async run(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { siteId?: string; tenantId?: string },
  ) {
    this.authorize(authorization);
    if (process.env.ENERGRID_LAB_MODE !== 'true')
      throw new ServiceUnavailableException(
        'Manual weather investigation is available only in LAB mode',
      );
    try {
      return await this.investigator.run(body?.siteId, body?.tenantId);
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
    if (body?.action !== 'acknowledged' && body?.action !== 'dismissed')
      throw new ServiceUnavailableException(
        'Action must be acknowledged or dismissed',
      );
    return this.investigator.acknowledge(
      id,
      body.action,
      body.siteId,
      body.tenantId,
    );
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
