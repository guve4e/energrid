import { BadRequestException, Body, Controller, Get, Post, NotFoundException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { EstimatorService } from './estimator.service';
import { EstimatorPersistenceService } from './estimator-persistence.service';
import { PreviewEstimateDto } from './dto/preview-estimate.dto';
import { PersistEstimateDto } from './dto/persist-estimate.dto';
import { AssistantStepDto } from './dto/assistant-step.dto';
import { EstimatorV2Service } from '../estimator-v2';
import { CatalogV2Service } from '../estimator-v2/catalog-v2.service';

@ApiTags('estimator')
@Controller('estimator')
export class EstimatorController {

  constructor(
    private readonly estimatorService: EstimatorService,
    private readonly estimatorV2Service: EstimatorV2Service,
    private readonly estimatorPersistenceService: EstimatorPersistenceService,
    private readonly catalogV2Service: CatalogV2Service,
  ) {}

  @Get('catalog')
  @ApiOperation({ summary: 'List active estimator catalog items' })
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

  @Get('pilot/context')
  async pilotContext() {
    if (process.env.ESTIMATOR_PILOT_ENABLED !== 'true') throw new NotFoundException();
    return this.estimatorV2Service.residentialContext();
  }

  @Post('pilot/calculate')
  async pilotCalculate(@Body() body: { facts: unknown }) {
    if (process.env.ESTIMATOR_PILOT_ENABLED !== 'true') throw new NotFoundException();
    if (!body?.facts || JSON.stringify(body.facts).length > 8000) throw new BadRequestException('Invalid facts');
    return this.estimatorV2Service.calculateResidential(body.facts);
  }

  @Post('preview')
  @ApiOperation({ summary: 'Preview an estimate without persisting it' })
  async preview(@Body() body: PreviewEstimateDto) {
    return this.estimatorService.preview(body);
  }

  @Post('assistant-step')
  @ApiOperation({ summary: 'Advance the assistant estimate draft by one user message' })
  async assistantStep(@Body() body: AssistantStepDto) {
    const useEstimatorV2 = process.env.ESTIMATOR_V2_ENABLED === 'true';


    if (useEstimatorV2) {
      return this.estimatorV2Service.step({
        tenantSlug: body.tenantSlug,
        message: body.message,
        draft: (body.draft as any) ?? undefined,
      });
    }

    return this.estimatorService.assistantStep(body);
  }

  @Post('persist')
  @ApiOperation({ summary: 'Persist a confirmed estimate' })
  async persist(@Body() body: PersistEstimateDto) {
    return this.estimatorPersistenceService.persistEstimate(body);
  }

  @Post('assistant-step-v2')
  @ApiOperation({ summary: 'Catalog-grounded estimate conversation for the public estimator' })
  async assistantStepV2(@Body() body: { message: string; customerHistory?: string[]; draft?: import('../estimator-v2/estimate-draft.types').EstimateConversationDraft }) {
    if (typeof body?.message !== 'string' || !body.message.trim() || body.message.length > 4000) {
      throw new BadRequestException('Message must contain 1–4000 characters');
    }
    if (body.draft && (typeof body.draft !== 'object' || Array.isArray(body.draft) || JSON.stringify(body.draft).length > 8000)) {
      throw new BadRequestException('Invalid estimate draft');
    }
    if (body.customerHistory && (!Array.isArray(body.customerHistory) || body.customerHistory.length > 12 || body.customerHistory.some(text => typeof text !== 'string') || body.customerHistory.join('\n').length > 8000)) throw new BadRequestException('Invalid customer history');
    return this.estimatorV2Service.step({ tenantSlug: 'energrid', message: body.message.trim(), draft: body.draft, ...(body.customerHistory ? { customerHistory: body.customerHistory } : {}) });
  }
}
