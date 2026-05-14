import { Module } from '@nestjs/common';
import { CatalogRepository } from '../estimator/catalog.repository';
import { CatalogV2Service } from './catalog-v2.service';
import { EstimateExplanationService } from './estimate-explanation.service';
import { EstimateIntakeService } from './estimate-intake.service';
import { EstimateQuestionService } from './estimate-question.service';
import { EstimatorV2Service } from './estimator-v2.service';
import { BoilerStrategy } from './strategies/boiler.strategy';
import { StoveStrategy } from './strategies/stove.strategy';

@Module({
  providers: [
    CatalogRepository,
    CatalogV2Service,
    EstimateExplanationService,
    EstimateIntakeService,
    EstimateQuestionService,
    EstimatorV2Service,
    BoilerStrategy,
    StoveStrategy,
  ],
  exports: [EstimatorV2Service, CatalogV2Service],
})
export class EstimatorV2Module {}
