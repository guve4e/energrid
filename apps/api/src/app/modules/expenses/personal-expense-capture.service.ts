import { BadGatewayException, Injectable } from '@nestjs/common';
import { LlmGatewayService } from '../llm/llm-gateway.service';

export interface ExpenseDraft {
  date: string | null;
  amount: number | null;
  currency: string | null;
  category: string | null;
  description: string | null;
  tags: string[];
  liters: number | null;
}

const OUTPUT_SCHEMA = {
  name: 'personal_expense_draft',
  schema: {
    type: 'object',
    properties: {
      date: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      amount: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      currency: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      category: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      description: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      tags: { type: 'array', items: { type: 'string' } },
      liters: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    },
    required: [
      'date',
      'amount',
      'currency',
      'category',
      'description',
      'tags',
      'liters',
    ],
    additionalProperties: false,
  },
};

@Injectable()
export class PersonalExpenseCaptureService {
  constructor(private readonly llm: LlmGatewayService) {}

  availability() {
    return this.llm.availability();
  }

  async parse(text: string, cloudDataConsent: boolean): Promise<ExpenseDraft> {
    const today = new Date().toISOString().slice(0, 10);
    const result = await this.llm.generate(
      {
        systemPrompt: [
          'Extract one personal expense from the user description.',
          'Return only facts stated or directly implied. Never invent an amount, merchant, currency, date, category, or fuel volume.',
          'Use ISO date YYYY-MM-DD when the date is explicit; use null when missing or ambiguous.',
          'Choose a concise common category, preserving any category the user named.',
          'Keep the transaction description short and useful. Use [] when no tags apply.',
          'Use liters only when the user clearly mentioned a fuel quantity; otherwise null.',
          `The current date is ${today}. Resolve relative dates only when unambiguous.`,
          'This is a draft. The user must review and save it; do not claim the expense was recorded.',
        ].join(' '),
        userPrompt: text,
        maxOutputTokens: 400,
        outputSchema: OUTPUT_SCHEMA,
      },
      { cloudDataConsent },
    );
    try {
      const parsed = JSON.parse(result.text) as ExpenseDraft;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tags))
        throw new Error('Invalid expense draft');
      return {
        date:
          typeof parsed.date === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
            ? parsed.date
            : null,
        amount:
          typeof parsed.amount === 'number' &&
          Number.isFinite(parsed.amount) &&
          parsed.amount > 0
            ? parsed.amount
            : null,
        currency:
          typeof parsed.currency === 'string'
            ? parsed.currency.trim().toUpperCase().slice(0, 3)
            : null,
        category:
          typeof parsed.category === 'string'
            ? parsed.category.trim().slice(0, 80)
            : null,
        description:
          typeof parsed.description === 'string'
            ? parsed.description.trim().slice(0, 500)
            : null,
        tags: parsed.tags
          .filter((tag): tag is string => typeof tag === 'string')
          .map((tag) => tag.trim().slice(0, 60))
          .filter(Boolean)
          .slice(0, 20),
        liters:
          typeof parsed.liters === 'number' &&
          Number.isFinite(parsed.liters) &&
          parsed.liters > 0
            ? parsed.liters
            : null,
      };
    } catch {
      throw new BadGatewayException(
        'Energrid could not turn that description into a usable expense draft. Try a shorter description.',
      );
    }
  }
}
