import { Injectable } from '@nestjs/common';
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

export interface EstimatorV2Result {
  status: 'needs_input' | 'preview' | 'explanation';
  reply: string;
  draft: EstimateConversationDraft;
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
  ) {}

  async preview(input: EstimateRequestInput) {
    const catalog = await this.catalogRepo.getActiveCatalog();
    return estimateProject(catalog, input);
  }

  async step(input: {
    tenantSlug: string;
    message: string;
    draft?: EstimateConversationDraft | null;
  }): Promise<EstimatorV2Result> {
    const update = await this.intakeService.extractEstimateUpdate({
      message: input.message,
      draft: input.draft ?? undefined,
    });

    const draft = mergeEstimateDraft({
      currentDraft: input.draft,
      update,
      tenantSlug: input.tenantSlug,
      rawMessage: input.message,
    });

    if (update.askExplanation && input.draft) {
      const catalog = await this.catalogRepo.getActiveCatalog();
      const estimateInput = mapDraftToEstimateRequest(draft);
      const preview = estimateProject(catalog, estimateInput);
      const explanation = this.explanationService.buildExplanation({
        draft,
        preview,
      });

      return {
        status: 'explanation',
        reply: this.explanationService.formatExplanation(explanation),
        draft,
        preview,
        explanation,
      };
    }

    if (draft.jobType === 'stove_installation') {
      return this.stoveStrategy.handle({ draft });
    }

    if (
      draft.jobType === 'boiler_installation' ||
      draft.jobType === 'boiler_replacement'
    ) {
      return this.boilerStrategy.handle({ draft });
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
