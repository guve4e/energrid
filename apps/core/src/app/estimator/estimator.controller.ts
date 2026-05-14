import { Body, Controller, Get, Logger, Post } from '@nestjs/common';
import { EstimatorService } from './estimator.service';
import { EstimatorPersistenceService } from './estimator-persistence.service';
import { PreviewEstimateDto } from './dto/preview-estimate.dto';
import { PersistEstimateDto } from './dto/persist-estimate.dto';
import { AssistantStepDto } from './dto/assistant-step.dto';
import { EstimatorV2Service } from '../estimator-v2';
import { CatalogV2Service } from '../estimator-v2/catalog-v2.service';

@Controller('estimator')
export class EstimatorController {
  private readonly logger = new Logger(EstimatorController.name);

  constructor(
    private readonly estimatorService: EstimatorService,
    private readonly estimatorV2Service: EstimatorV2Service,
    private readonly estimatorPersistenceService: EstimatorPersistenceService,
    private readonly catalogV2Service: CatalogV2Service,
  ) {}

  @Get('catalog')
  async catalog() {
    const items = await this.catalogV2Service.listActive();

    return {
      items: items.map((x) => ({
        code: x.code,
        category: x.category,
        nameBg: x.name_bg,
        unit: x.unit,
        basePrice: Number(x.base_price),
        pricingMode: x.pricing_mode,
        laborIncluded: x.labor_included,
        materialsIncluded: x.materials_included,
        isActive: x.is_active,
      })),
    };
  }

  @Post('preview')
  async preview(@Body() body: PreviewEstimateDto) {
    return this.estimatorService.preview(body);
  }

  @Post('assistant-step')
  async assistantStep(@Body() body: AssistantStepDto) {
    const useEstimatorV2 = process.env.ESTIMATOR_V2_ENABLED === 'true';

    this.logger.warn(
      `assistant-step route useEstimatorV2=${useEstimatorV2} tenant=${body.tenantSlug} message="${body.message}"`,
    );

    if (useEstimatorV2) {
      this.logger.warn('assistant-step using V2 service');
      return this.estimatorV2Service.step({
        tenantSlug: body.tenantSlug,
        message: body.message,
        draft: (body.draft as any) ?? undefined,
      });
    }

    this.logger.warn('assistant-step using OLD service');
    return this.estimatorService.assistantStep(body);
  }

  @Post('persist')
  async persist(@Body() body: PersistEstimateDto) {
    return this.estimatorPersistenceService.persistEstimate(body);
  }
}
