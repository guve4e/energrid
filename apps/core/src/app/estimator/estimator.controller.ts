import { Body, Controller, Post } from '@nestjs/common';
import { EstimatorService } from './estimator.service';
import { EstimatorPersistenceService } from './estimator-persistence.service';
import { PreviewEstimateDto } from './dto/preview-estimate.dto';
import { PersistEstimateDto } from './dto/persist-estimate.dto';
import { AssistantStepDto } from './dto/assistant-step.dto';

@Controller('estimator')
export class EstimatorController {
  constructor(
    private readonly estimatorService: EstimatorService,
    private readonly estimatorPersistenceService: EstimatorPersistenceService,
  ) {}

  @Post('preview')
  async preview(@Body() body: PreviewEstimateDto) {
    return this.estimatorService.preview(body);
  }

  @Post('assistant-step')
  async assistantStep(@Body() body: AssistantStepDto) {
    return this.estimatorService.assistantStep(body);
  }

  @Post('persist')
  async persist(@Body() body: PersistEstimateDto) {
    return this.estimatorPersistenceService.persistEstimate(body);
  }
}
