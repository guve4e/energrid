import { Module } from '@nestjs/common';
import { DbModule } from './db.module';
import { EstimatorModule } from './estimator/estimator.module';

// Local preview only: no weather/river collectors or device automation schedulers.
@Module({ imports: [DbModule, EstimatorModule] })
export class EstimatorLocalModule {}
