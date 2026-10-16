import { Body, Controller, Get, Headers, Post, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { VIDIN_LOCATION, WeatherObservation, WeatherVerificationService } from './weather-verification.service';
import { WeatherDailyVerificationService } from './weather-daily-verification.service';
import { WeatherObservationCollector } from './weather-observation-collector.service';

@Controller('weather')
export class WeatherVerificationController {
  constructor(private readonly verification: WeatherVerificationService,
    private readonly daily: WeatherDailyVerificationService,
    private readonly observations: WeatherObservationCollector) {}
  @Get('performance')
  async performance() {
    try {
      const hourly = await this.verification.performance();
      let daily;
      try { daily = await this.daily.performance(); }
      catch (error) {
        if (!['42P01', '42703'].includes((error as { code?: string }).code ?? '')) throw error;
        daily = { status: 'migration-required', summary: [], recent: [] };
      }
      return { ...hourly, daily, collection: this.observations.status() };
    }
    catch (error) {
      if (['42P01', '42703'].includes((error as { code?: string }).code ?? '')) {
        return { status: 'migration-required', summary: [], note: 'Forecast verification storage is not initialized.' };
      }
      throw new ServiceUnavailableException('Forecast verification is temporarily unavailable');
    }
  }

  @Post('observations')
  async observe(@Headers('authorization') authorization: string | undefined,
    @Body() body: { observations?: WeatherObservation[] }) {
    const token = process.env.WEATHER_OBSERVATION_TOKEN;
    const source = process.env.WEATHER_OBSERVATION_SOURCE;
    if (!token || !source) throw new ServiceUnavailableException('A measured observation source must be configured first');
    const hash = (value: string) => createHash('sha256').update(value).digest();
    if (!authorization || !timingSafeEqual(hash(authorization), hash(`Bearer ${token}`))) throw new UnauthorizedException();
    // Source and location belong to the server's configured station, never to caller labels.
    return this.verification.ingest(source, VIDIN_LOCATION, body?.observations ?? []);
  }
}
