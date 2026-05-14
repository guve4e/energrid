import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DbModule } from './db.module';
import { EstimatorModule } from './estimator/estimator.module';
import { EstimatorV2Module } from './estimator-v2';
import { InstallationsModule } from './installations/installations.module';

@Module({
  imports: [DbModule, EstimatorModule, EstimatorV2Module, InstallationsModule],
  controllers: [HealthController],
})
export class AppModule {}

