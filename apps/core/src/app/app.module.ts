import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DbModule } from './db.module';
import { EstimatorModule } from './estimator/estimator.module';

@Module({
  imports: [DbModule, EstimatorModule],
  controllers: [HealthController],
})
export class AppModule {}
