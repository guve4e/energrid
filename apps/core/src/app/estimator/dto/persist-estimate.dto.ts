import { PreviewEstimateDto } from './preview-estimate.dto';

export class PersistEstimateDto {
  source?: 'assistant' | 'manual' | 'designer';
  leadId?: string | null;
  conversationId?: string | null;
  projectName?: string | null;
  city?: string | null;
  address?: string | null;
  estimateInput!: PreviewEstimateDto;
}
