import { Module } from '@nestjs/common';
import { EstimatorController } from './estimator.controller';
import { CatalogRepository } from './catalog.repository';
import { ProjectsRepository } from './projects.repository';
import { EstimatesRepository } from './estimates.repository';
import { EstimatorService } from './estimator.service';
import { EstimatorPersistenceService } from './estimator-persistence.service';

@Module({
  controllers: [EstimatorController],
  providers: [
    CatalogRepository,
    ProjectsRepository,
    EstimatesRepository,
    EstimatorService,
    EstimatorPersistenceService,
  ],
})
export class EstimatorModule {}
