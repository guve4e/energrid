import { Injectable } from '@nestjs/common';
import type { EstimateConversationDraft } from '../estimate-draft.types';
import { EstimateQuestionService } from '../estimate-question.service';
import { CatalogV2Service } from '../catalog-v2.service';
import { computeMissingFields } from '../estimate-draft.utils';
import { estimateAppliance, formatRangeEstimate, type RangeEstimate } from '../appliance-estimate';

export interface StoveStrategyResult {
  status: 'needs_input' | 'preview';
  reply: string;
  draft: EstimateConversationDraft;
  rangePreview?: RangeEstimate;
}

@Injectable()
export class StoveStrategy {
  constructor(private readonly questionService: EstimateQuestionService, private readonly catalog: CatalogV2Service) {}
  async handle({ draft }: { draft: EstimateConversationDraft }): Promise<StoveStrategyResult> {
    const missingFields = computeMissingFields(draft);
    if (missingFields.length) {
      draft.currentQuestionField = missingFields[0] as EstimateConversationDraft['currentQuestionField'];
      return { status: 'needs_input', draft, reply: await this.questionService.generateFollowupQuestion({ draft, missingFields }) };
    }
    const rangePreview = await estimateAppliance(draft, this.catalog);
    return { status: 'preview', draft, rangePreview, reply: formatRangeEstimate(rangePreview) };
  }
}
