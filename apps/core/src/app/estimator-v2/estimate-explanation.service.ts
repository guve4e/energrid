import { Injectable } from '@nestjs/common';
import type { EstimateConversationDraft } from './estimate-draft.types';

@Injectable()
export class EstimateExplanationService {
  buildExplanation(input: {
    draft: EstimateConversationDraft;
    preview: {
      subtotal: number;
      currency: string;
      assumptions: string[];
      lines: Array<{
        label: string;
        quantity: number;
        unit: string;
        unitPrice: number;
        subtotal: number;
      }>;
    };
  }): {
    summaryBg: string;
    steps: string[];
  } {
    const steps = input.preview.lines.map(
      (line) =>
        `${line.label}: ${line.quantity} ${line.unit} × ${line.unitPrice.toFixed(2)} = ${line.subtotal.toFixed(2)} ${input.preview.currency}.`,
    );

    for (const assumption of input.preview.assumptions ?? []) {
      steps.push(`Допускане: ${assumption}`);
    }

    return {
      summaryBg: `Изчислението е направено по текущата чернова и ценовия каталог. Общо: ${input.preview.subtotal.toFixed(2)} ${input.preview.currency}.`,
      steps,
    };
  }

  formatExplanation(explanation: {
    summaryBg: string;
    steps: string[];
  }): string {
    return [
      explanation.summaryBg,
      '',
      ...explanation.steps.slice(0, 4).map((x, i) => `${i + 1}. ${x}`),
    ]
      .filter(Boolean)
      .join('\n');
  }
}
