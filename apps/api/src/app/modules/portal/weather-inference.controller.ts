import { Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { WeatherInferenceService } from './weather-inference.service';

@Controller('weather/investigator')
export class WeatherInferenceController {
  constructor(private readonly inference: WeatherInferenceService) {}
  @Post('infer') infer(@Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
    const token = process.env.WEATHER_INVESTIGATOR_API_TOKEN;
    if (process.env.ENERGRID_LAB_MODE !== 'true' || !token || !authorization) throw new UnauthorizedException();
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(digest(authorization), digest(`Bearer ${token}`))) throw new UnauthorizedException();
    return this.inference.investigate(body);
  }
}
