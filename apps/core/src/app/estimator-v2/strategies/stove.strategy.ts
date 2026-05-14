import { Injectable } from '@nestjs/common';
import type { EstimateConversationDraft } from '../estimate-draft.types';
import { EstimateQuestionService } from '../estimate-question.service';
import { CatalogV2Service } from '../catalog-v2.service';

export interface StoveStrategyResult {
  status: 'needs_input' | 'preview';
  reply: string;
  draft: EstimateConversationDraft;
}

@Injectable()
export class StoveStrategy {
  constructor(
    private readonly questionService: EstimateQuestionService,
    private readonly catalog: CatalogV2Service,
  ) {}

  async handle(input: {
    draft: EstimateConversationDraft;
  }): Promise<StoveStrategyResult> {
    const { draft } = input;

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
          'Питам, защото цената зависи дали ще се ползва съществуващ кабел и дали са нужни защити или корекции по захранването.',
        draft,
      };
    }

    const usingExistingCable =
      draft.connectionMode === 'existing_cable_only' ||
      draft.powerSource === 'existing_line';

    const needsNewLine =
      draft.connectionMode === 'new_line_required' ||
      draft.powerSource === 'panel';

    if (!usingExistingCable && !needsNewLine) {
      const rows = await this.catalog.getManyByCodes([
        'stove_existing_cable_min',
        'stove_existing_cable_max',
        'stove_new_line_base_min',
        'stove_new_line_base_max',
      ]);

      const existingMin = Number(rows.stove_existing_cable_min.base_price);
      const existingMax = Number(rows.stove_existing_cable_max.base_price);
      const newLineMin = Number(rows.stove_new_line_base_min.base_price);
      const newLineMax = Number(rows.stove_new_line_base_max.base_price);

      draft.currentQuestionField = 'connectionMode';

      return {
        status: 'preview',
        reply: [
          'Ориентировъчно цената за труд е:',
          `– около ${existingMin}–${existingMax} EUR ако има готов кабел и е подходящ`,
          `– около ${newLineMin}–${newLineMax} EUR ако трябва ново трасе или корекции`,
          '',
          'Материалите не са включени.',
          '',
          'Ще се ползва ли съществуващият кабел / контакт на старата печка или трябва ново трасе?',
        ].join('\n'),
        draft,
      };
    }

    if (usingExistingCable) {
      const rows = await this.catalog.getManyByCodes([
        'stove_existing_cable_min',
        'stove_existing_cable_max',
      ]);

      const min = Number(rows.stove_existing_cable_min.base_price);
      const max = Number(rows.stove_existing_cable_max.base_price);

      return {
        status: 'preview',
        reply: [
          'Ориентировъчно цената за труд е:',
          `– около ${min}–${max} EUR ако връзката е директна и съществуващият кабел е подходящ`,
          '',
          'Материалите не са включени.',
          'За точна цена трябва да се види дали кабелът е подходящ и каква защита има в таблото.',
        ].join('\n'),
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
            'Ако ще се пуска ново трасе, колко е приблизително разстоянието до котлоните в метри?',
          draft,
        };
      }

      const rows = await this.catalog.getManyByCodes([
        'stove_new_line_base_min',
        'stove_new_line_base_max',
        'stove_new_line_extra_meter_min',
        'stove_new_line_extra_meter_max',
      ]);

      const baseMin = Number(rows.stove_new_line_base_min.base_price);
      const baseMax = Number(rows.stove_new_line_base_max.base_price);
      const extraMin = Number(rows.stove_new_line_extra_meter_min.base_price);
      const extraMax = Number(rows.stove_new_line_extra_meter_max.base_price);

      const extraMeters = Math.max(0, meters - 3);
      const min = baseMin + extraMeters * extraMin;
      const max = baseMax + extraMeters * extraMax;

      return {
        status: 'preview',
        reply: [
          `Ако за котлоните трябва ново трасе около ${meters} м, ориентировъчната цена за труд е около ${min.toFixed(2)}–${max.toFixed(2)} EUR.`,
          '',
          'Материалите не са включени.',
          'При нужда от нови защити, корекции в таблото или по-сложен монтаж цената може да е по-висока.',
        ].join('\n'),
        draft,
      };
    }

    return {
      status: 'preview',
      reply: [
        'За свързване на котлони ориентировъчната цена за труд обикновено е според това дали се ползва съществуващ кабел или се налага преработка.',
        'Материалите не са включени.',
      ].join('\n'),
      draft,
    };
  }
}
