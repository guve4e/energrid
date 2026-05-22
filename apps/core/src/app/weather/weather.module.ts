import { Module } from '@nestjs/common';
import { WeatherController } from './weather.controller';
import { WeatherService } from './weather.service';
import { WeatherProviderService } from './weather-provider.service';
import { WeatherRiskEngine } from './weather-risk.engine';
import { DanubeProviderService } from './danube-provider.service';

@Module({
  controllers: [WeatherController],
  providers: [
    WeatherService,
    WeatherProviderService,
    WeatherRiskEngine,
    DanubeProviderService,
  ],
})
export class WeatherModule {}
