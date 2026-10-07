import { estimateResidential } from './residential-estimate';
import { residentialEducation } from './residential-education';
import { ResidentialTemplateRepository } from './residential-template.repository';
import { residentialFollowup, answerResidentialFollowup } from './residential-followup';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  estimateProject,
  type EstimateRequestInput,
} from '@energrid/domain-estimator';
import { CatalogRepository } from '../estimator/catalog.repository';
import { EstimateExplanationService } from './estimate-explanation.service';
import { EstimateIntakeService } from './estimate-intake.service';
import { EstimateQuestionService } from './estimate-question.service';
import {
  computeMissingFields,
  mergeEstimateDraft,
} from './estimate-draft.utils';
import type { EstimateConversationDraft } from './estimate-draft.types';
import { mapDraftToEstimateRequest } from './estimate-mapper';
import { BoilerStrategy } from './strategies/boiler.strategy';
import {StoveStrategy} from "./strategies/stove.strategy";
import { type ResidentialPlan } from './residential-plan';
import { validateEstimateDraft } from './validate-estimate-draft';

export interface EstimatorV2Result {
  status: 'needs_input' | 'preview' | 'explanation' | 'needs_inspection' | 'proposal';
  reply: string;
  draft: EstimateConversationDraft;
  plan?: ResidentialPlan;
  rangePreview?: import('./appliance-estimate').RangeEstimate;
  preview?: ReturnType<typeof estimateProject>;
  explanation?: {
    summaryBg: string;
    steps: string[];
  };
}

@Injectable()
export class EstimatorV2Service {
  constructor(
    private readonly catalogRepo: CatalogRepository,
    private readonly intakeService: EstimateIntakeService,
    private readonly questionService: EstimateQuestionService,
    private readonly explanationService: EstimateExplanationService,
    private readonly boilerStrategy: BoilerStrategy,
    private readonly stoveStrategy: StoveStrategy,
    private readonly templateRepo?: ResidentialTemplateRepository,
  ) {}

  async preview(input: EstimateRequestInput) {
    const catalog = await this.catalogRepo.getActiveCatalog();
    return estimateProject(catalog, input);
  }

  async residentialContext() {
    const catalog = await this.catalogRepo.getActiveCatalog();
    const template=await this.templateRepo!.get();
    return { template, education:residentialEducation(template), catalog: catalog.filter(row => /^(power_point|power_line|socket_or_switch_concealed|panel_|smart_relay|chasing_)/.test(row.code)) };
  }

  async calculateResidential(facts: unknown) {
    const draft = validateEstimateDraft(facts, 'energrid');
    if (!draft) throw new Error('Residential facts are required');
    draft.jobType = 'residential_installation';
    const template = await this.templateRepo!.get(draft.templateVersion);
    const result = estimateResidential(draft, await this.catalogRepo.getActiveCatalog(), '', undefined, template);
    // No LLM call or quote write. The conversational owner receives facts, not scripted prose.
    return { status: result.status, facts: result.draft, estimate: result.rangePreview ?? null, circuits: result.circuitProposal ?? null, template, calculatedAt: new Date().toISOString() };
  }

  async step(input: {
    tenantSlug: string;
    message: string;
    customerHistory?: string[];
    draft?: EstimateConversationDraft | null;
  }): Promise<EstimatorV2Result> {
    const validated = validateEstimateDraft(input.draft, input.tenantSlug);
    input = { ...input, draft: validated?.jobType ? validated : undefined };
    if (input.draft?.jobType === 'residential_installation') {
      const followup = residentialFollowup(input.message, input.draft);
      if (followup) return answerResidentialFollowup(followup, input.draft, await this.catalogRepo.getActiveCatalog(), await this.templateRepo?.get(input.draft.templateVersion));
    }
    if (!process.env.OPENAI_API_KEY) throw new ServiceUnavailableException('Estimate assistant is not configured');
    const update = await this.intakeService.extractEstimateUpdate({
      message: input.message,
      customerHistory: input.customerHistory,
      draft: input.draft ?? undefined,
    });

    // Questions must not mutate an existing quote even if extraction suggests fields.
    const safeUpdate = input.draft && update.userIntent === 'explanation'
      ? { updates: {}, askExplanation: true }
      : update;
    const draft = mergeEstimateDraft({
      currentDraft: input.draft,
      update: safeUpdate,
      tenantSlug: input.tenantSlug,
      rawMessage: input.message,
    });
    validateEstimateDraft(draft, input.tenantSlug);
    if (draft.jobType === 'residential_installation') return estimateResidential(draft, await this.catalogRepo.getActiveCatalog(), input.message, input.draft, await this.templateRepo?.get(draft.templateVersion));

    // A dedicated AC connection price is absent from the current catalog. Never substitute a power point.
    if (draft.jobType === 'ac_installation') {
      const catalog = await this.catalogRepo.getActiveCatalog();
      if (!catalog.some(row => row.code === 'ac_connection')) return {
        status: 'needs_inspection', draft,
        reply: 'В каталога няма активна цена за свързване на климатик. Не можем да дадем надеждна сума; необходима е индивидуална оценка.',
      };
    }

    if (draft.jobType === 'stove_installation') {
      const result = await this.stoveStrategy.handle({ draft });
      return { ...result, status: update.askExplanation && result.status === 'preview' ? 'explanation' : result.status };
    }

    if (
      draft.jobType === 'boiler_installation' ||
      draft.jobType === 'boiler_replacement'
    ) {
      const result = await this.boilerStrategy.handle({ draft });
      return { ...result, status: update.askExplanation && result.status === 'preview' ? 'explanation' : result.status };
    }

    const missingFields = computeMissingFields(draft);

    if (missingFields.length > 0) {
      const field = missingFields[0];
      const reply = await this.questionService.generateFollowupQuestion({
        draft,
        missingFields,
      });

      draft.currentQuestionField = field as any;

      return {
        status: 'needs_input',
        reply,
        draft,
      };
    }

    const catalog = await this.catalogRepo.getActiveCatalog();
    const estimateInput = mapDraftToEstimateRequest(draft);
    const preview = estimateProject(catalog, estimateInput);
    if (draft.panelKind === 'panel_custom') preview.assumptions.push('Цената за табло по индивидуален проект е минимална, а не крайна.');
    if (update.askExplanation) {
      const explanation = this.explanationService.buildExplanation({ draft, preview });
      return { status: 'explanation', reply: this.explanationService.formatExplanation(explanation), draft, preview, explanation };
    }

    return {
      status: 'preview',
      reply: this.formatPreviewReply(preview),
      draft,
      preview,
    };
  }

  private formatPreviewReply(preview: {
    subtotal: number;
    currency: string;
    assumptions: string[];
    needsInspection: boolean;
  }): string {
    const subtotalText = `${preview.subtotal.toFixed(2)} ${preview.currency}`;
    const materialNote = preview.assumptions.some((x) =>
      x.toLowerCase().includes('материалите не са включени'),
    )
      ? 'Материалите не са включени.'
      : '';

    const inspectionNote = preview.needsInspection
      ? 'За точна оферта препоръчваме оглед.'
      : '';

    return [
      `По подадените данни ориентировъчната цена за труд е около ${subtotalText}.`,
      materialNote,
      inspectionNote,
    ]
      .filter(Boolean)
      .join(' ');
  }
}
