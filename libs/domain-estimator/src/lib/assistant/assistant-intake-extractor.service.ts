import type { AssistantExtraction } from './assistant-intake-extractor.types';
import { buildExtractorPrompt } from './assistant-intake-extractor.prompts';

export class AssistantIntakeExtractorService {
  async extract(input: {
    message: string;
    draftSummary?: string;
  }): Promise<AssistantExtraction> {
    const prompt = buildExtractorPrompt(input);

    // TODO: replace with real LLM call
    console.log('LLM PROMPT:', prompt);

    // TEMP fallback (so app still works)
    return {
      action: 'unknown',
    };
  }
}
