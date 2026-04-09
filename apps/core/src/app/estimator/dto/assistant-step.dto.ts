import type { AssistantEstimateDraft } from '@energrid/domain-estimator';

export class AssistantStepDto {
  tenantSlug!: string;
  message!: string;
  draft?: AssistantEstimateDraft | null;
}
