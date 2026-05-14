import { Injectable } from '@nestjs/common';
import type { EstimateConversationDraft } from '../estimate-draft.types';
import { EstimateQuestionService } from '../estimate-question.service';
import { CatalogV2Service } from '../catalog-v2.service';

export interface BoilerStrategyResult {
  status: 'needs_input' | 'preview';
  reply: string;
  draft: EstimateConversationDraft;
}

@Injectable()
export class BoilerStrategy {
  constructor(
    private readonly questionService: EstimateQuestionService,
    private readonly catalog: CatalogV2Service,
  ) {}

  async handle(input: {
    draft: EstimateConversationDraft;
  }): Promise<BoilerStrategyResult> {
    const { draft } = input;

    const isReplacement = draft.jobType === 'boiler_replacement';

    if (!draft.quantity) {
      draft.currentQuestionField = 'quantity';

      return {
        status: 'needs_input',
        reply: await this.questionService.generateFollowupQuestion({
          draft,
          missingFields: ['quantity'],
        }),
        draft,
      };
    }

    if (draft.currentIntent === 'question_why') {
      return {
        status: 'needs_input',
        reply:
          'Питам, защото ако е само подмяна със съществуващ кабел, цената е една. Ако трябва ново трасе или нова защита, цената става по-висока.',
        draft,
      };
    }

    const usingExistingCable =
      draft.connectionMode === 'existing_cable_only' ||
      draft.powerSource === 'existing_line';

    const needsNewLine =
      draft.connectionMode === 'new_line_required' ||
      draft.powerSource === 'panel';

    if (isReplacement && usingExistingCable) {
      const rows = await this.catalog.getManyByCodes([
        'boiler_replacement_existing_cable_min',
        'boiler_replacement_existing_cable_max',
      ]);

      const min = Number(rows.boiler_replacement_existing_cable_min.base_price);
      const max = Number(rows.boiler_replacement_existing_cable_max.base_price);

      return {
        status: 'preview',
        reply: [
          `За подмяна на стар бойлер с нов, ако се ползва съществуващият кабел и няма нужда от ново трасе, ориентировъчната цена за труд е около ${min}–${max} EUR.`,
          '',
          'Силно препоръчваме дефектнотокова защита (RCD), особено при по-стари инсталации. Това е допълнителен разход, но е важна защита.',
          '',
          'Материалите не са включени. Ако се окаже, че е нужна нова линия или допълнителни корекции, цената ще е по-висока.',
        ].join('\n'),
        draft,
      };
    }

    if (isReplacement && !usingExistingCable && !needsNewLine) {
      draft.currentQuestionField = 'connectionMode';

      return {
        status: 'needs_input',
        reply:
          'За подмяна на бойлер ще се ползва ли съществуващият кабел или трябва ново трасе?',
        draft,
      };
    }

    if (needsNewLine) {
      const meters = draft.routeLengthMeters;

      if (!meters) {
        draft.currentQuestionField = 'routeLengthMeters';

        return {
          status: 'needs_input',
          reply:
            'Колко е приблизително трасето до бойлера в метри? Ако не сте сигурни, дайте груба преценка.',
          draft,
        };
      }

      const rows = await this.catalog.getManyByCodes([
        'boiler_new_line_base_min',
        'boiler_new_line_base_max',
        'boiler_new_line_extra_meter_min',
        'boiler_new_line_extra_meter_max',
      ]);

      const baseMin = Number(rows.boiler_new_line_base_min.base_price);
      const baseMax = Number(rows.boiler_new_line_base_max.base_price);
      const extraMin = Number(rows.boiler_new_line_extra_meter_min.base_price);
      const extraMax = Number(rows.boiler_new_line_extra_meter_max.base_price);

      const extraMeters = Math.max(0, meters - 3);
      const min = baseMin + extraMeters * extraMin;
      const max = baseMax + extraMeters * extraMax;

      return {
        status: 'preview',
        reply: [
          `Ако за бойлера трябва ново трасе около ${meters} м, ориентировъчната цена за труд е около ${min.toFixed(2)}–${max.toFixed(2)} EUR.`,
          '',
          'Препоръчваме да се предвиди подходящ автомат и дефектнотокова защита (RCD). Това е допълнителен разход, но е силно препоръчително.',
          '',
          'Материалите не са включени. При бетон, труден достъп или допълнителни корекции цената може да се промени.',
        ].join('\n'),
        draft,
      };
    }

    const rows = await this.catalog.getManyByCodes([
      'boiler_replacement_existing_cable_min',
      'boiler_replacement_existing_cable_max',
      'boiler_new_line_base_min',
      'boiler_new_line_base_max',
    ]);

    const existingMin = Number(rows.boiler_replacement_existing_cable_min.base_price);
    const existingMax = Number(rows.boiler_replacement_existing_cable_max.base_price);
    const newLineMin = Number(rows.boiler_new_line_base_min.base_price);
    const newLineMax = Number(rows.boiler_new_line_base_max.base_price);

    return {
      status: 'preview',
      reply: [
        `За бойлер ориентировъчната цена за труд обикновено е около ${existingMin}–${existingMax} EUR при съществуващ кабел и около ${newLineMin}–${newLineMax} EUR ако трябва ново трасе.`,
        '',
        'Материалите не са включени.',
      ].join('\n'),
      draft,
    };
  }
}
