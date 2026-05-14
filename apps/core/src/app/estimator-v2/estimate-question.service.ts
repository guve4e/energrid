import { Injectable, Logger } from '@nestjs/common';
import type { EstimateConversationDraft } from './estimate-draft.types';

@Injectable()
export class EstimateQuestionService {
  private readonly logger = new Logger(EstimateQuestionService.name);

  async generateFollowupQuestion(input: {
    draft: EstimateConversationDraft;
    missingFields: string[];
  }): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_SMALL_MODEL || 'gpt-4.1-mini';

    if (!apiKey) {
      return this.fallbackQuestion(input.missingFields[0] ?? 'jobType');
    }

    const prompt = [
      'You write one short Bulgarian follow-up question for an electrical estimate assistant.',
      'Ask only one question.',
      'Do not ask for information already known.',
      'Be practical, concise, and non-robotic.',
      'Do not explain pricing yet.',
      `Draft: ${JSON.stringify(input.draft)}`,
      `Missing fields: ${JSON.stringify(input.missingFields)}`,
      'Return JSON only: {"reply":"..."}',
    ].join('\n');

    try {
      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: prompt,
          text: {
            format: {
              type: 'json_schema',
              name: 'followup_question',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  reply: { type: 'string' },
                },
                required: ['reply'],
              },
            },
          },
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        this.logger.warn(`followup question failed status=${res.status} body=${text}`);
        return this.fallbackQuestion(input.missingFields[0] ?? 'jobType');
      }

      const json = (await res.json()) as {
        output_text?: string;
        output?: Array<{
          content?: Array<{ type?: string; text?: string }>;
        }>;
      };

      const rawText =
        (typeof json.output_text === 'string' ? json.output_text : undefined) ??
        json.output
          ?.flatMap((x) => x.content ?? [])
          .find((x) => x.type === 'output_text' && typeof x.text === 'string')
          ?.text ??
        '{"reply":"Опишете какво точно искате да се направи."}';

      const parsed = JSON.parse(rawText) as { reply?: string };
      return parsed.reply?.trim() || this.fallbackQuestion(input.missingFields[0] ?? 'jobType');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`followup question exception: ${message}`);
      return this.fallbackQuestion(input.missingFields[0] ?? 'jobType');
    }
  }

  fallbackQuestion(field: string, draft?: EstimateConversationDraft): string {
    const job = draft?.jobType;

    // 🔥 JOB-AWARE QUESTIONS

    if (job === 'boiler_replacement') {
      if (field === 'powerSource') {
        return 'Ще се ползва ли съществуващият кабел за бойлера или трябва ново трасе?';
      }

      if (field === 'quantity') {
        return 'Колко бойлера ще се подменят?';
      }
    }

    if (job === 'boiler_installation') {
      if (field === 'routeLengthMeters') {
        return 'Колко е приблизително разстоянието до бойлера в метри?';
      }

      if (field === 'wallType') {
        return 'Ще има ли къртене или кабелът ще мине открито?';
      }

      if (field === 'powerSource') {
        return 'Ще се пуска ли нова линия от таблото или има готово захранване?';
      }
    }

    if (job === 'stove_installation') {
      if (field === 'powerSource') {
        return 'Печката ще е на трифазен ток или стандартен контакт?';
      }

      if (field === 'routeLengthMeters') {
        return 'Колко е разстоянието от таблото до печката?';
      }
    }

    if (job === 'ac_installation') {
      if (field === 'powerSource') {
        return 'Климатикът ще е на отделен токов кръг или има готов контакт?';
      }
    }

    if (job === 'points') {
      if (field === 'quantity') {
        return 'Колко контакта или точки искате да се изградят?';
      }
    }

    // 🔥 GENERIC FALLBACK (LAST RESORT)

    switch (field) {
      case 'quantity':
        return 'Колко броя са?';
      case 'routeLengthMeters':
        return 'Колко е приблизително трасето в метри?';
      case 'wallType':
        return 'Ще има ли къртене или монтажът е без къртене?';
      case 'powerSource':
        return 'Ще се захранва от съществуваща линия или ще се пуска нова?';
      case 'panelKind':
        return 'Какъв тип табло е необходимо?';
      default:
        return 'Опишете с 1–2 изречения какво точно искате да се направи.';
    }
  }
}
