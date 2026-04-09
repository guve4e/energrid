import { Injectable, Logger } from '@nestjs/common';
import {
  estimateProject,
  getDraftNextAction,
  type AssistantEstimateDraft,
  type EstimateRequestInput,
} from '@energrid/domain-estimator';
import { CatalogRepository } from './catalog.repository';

export interface AssistantStepExplanation {
  steps: string[];
  summaryBg: string;
}

export interface AssistantStepResult {
  status: 'needs_input' | 'preview' | 'updated_preview' | 'explanation';
  operation:
    | 'start_estimate'
    | 'fill_missing_field'
    | 'add_item'
    | 'update_item'
    | 'remove_item'
    | 'recalculate'
    | 'summarize'
    | 'explain'
    | 'unknown';
  reply: string;
  draft: AssistantEstimateDraft;
  preview?: ReturnType<typeof estimateProject> extends infer T ? T : never;
  explanation?: AssistantStepExplanation;
}

type AssistantExtraction =
  | {
      action: 'set_scope' | 'add_scope';
      entityType: 'point' | 'device' | 'panel';
      entityKind: string;
      quantity?: number;
      routeLengthMeters?: number;
      wallType?: 'brick' | 'concrete' | 'drywall' | 'none';
      notes?: string;
    }
  | {
      action: 'fill_missing_field';
      field: 'quantity' | 'routeLengthMeters' | 'wallType';
      value: string | number;
    }
  | {
      action: 'ask_explanation';
    }
  | {
      action: 'unknown';
      notes?: string;
    };

@Injectable()
export class EstimatorService {
  private readonly logger = new Logger(EstimatorService.name);

  constructor(private readonly catalogRepo: CatalogRepository) {}

  async preview(input: EstimateRequestInput) {
    const catalog = await this.catalogRepo.getActiveCatalog();
    return estimateProject(catalog, input);
  }

  async assistantStep(input: {
    tenantSlug: string;
    message: string;
    draft?: AssistantEstimateDraft | null;
  }): Promise<AssistantStepResult> {
    const catalog = await this.catalogRepo.getActiveCatalog();

    const { applyExtractionToDraft, mapDraftToEstimateInput } = await import(
      '@energrid/domain-estimator'
    );

    const hadExistingDraft = Boolean(input.draft);
    const operation = this.detectOperation(input.message, hadExistingDraft);

    const extraction = await this.extractWithMiniModel({
      message: input.message,
      draft: input.draft ?? undefined,
    });

    if (extraction.action === 'ask_explanation') {
      const draft = input.draft ?? this.createEmptyDraft(input.tenantSlug);
      const estimateInput = mapDraftToEstimateInput(draft);
      const preview = estimateProject(catalog, estimateInput);
      const explanation = this.buildExplanation(draft, preview);

      return {
        status: 'explanation',
        operation: 'explain',
        reply: this.formatExplanationReply(explanation),
        draft,
        preview,
        explanation,
      };
    }

    const draft = applyExtractionToDraft({
      tenantSlug: input.tenantSlug,
      extraction,
      currentDraft: input.draft ?? undefined,
    });

    const nextAction = getDraftNextAction(draft);

    if (nextAction.type === 'ask_missing_field') {
      return {
        status: 'needs_input',
        operation: 'fill_missing_field',
        reply: nextAction.question,
        draft,
      };
    }

    const estimateInput = mapDraftToEstimateInput(draft);
    const preview = estimateProject(catalog, estimateInput);

    if (operation === 'explain') {
      const explanation = this.buildExplanation(draft, preview);

      return {
        status: 'explanation',
        operation,
        reply: this.formatExplanationReply(explanation),
        draft,
        preview,
        explanation,
      };
    }

    return {
      status: hadExistingDraft ? 'updated_preview' : 'preview',
      operation,
      reply: this.formatPreviewReply(preview),
      draft,
      preview,
    };
  }

  private createEmptyDraft(tenantSlug: string): AssistantEstimateDraft {
    return {
      tenantSlug,
      includeConsultation: false,
      points: [],
      devices: [],
      panels: [],
      notes: '',
    };
  }

  private async extractWithMiniModel(input: {
    message: string;
    draft?: AssistantEstimateDraft;
  }): Promise<AssistantExtraction> {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_SMALL_MODEL || 'gpt-4.1-mini';

    if (!apiKey) {
      this.logger.warn(
        'OPENAI_API_KEY missing; falling back to unknown extraction'
      );
      return { action: 'unknown' };
    }

    const prompt = this.buildMiniExtractorPrompt({
      message: input.message,
      draft: input.draft,
    });

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
              name: 'assistant_extraction',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'action',
                  'entityType',
                  'entityKind',
                  'quantity',
                  'routeLengthMeters',
                  'wallType',
                  'field',
                  'value',
                  'notes'
                ],
                properties: {
                  action: {
                    type: 'string',
                    enum: [
                      'set_scope',
                      'add_scope',
                      'fill_missing_field',
                      'ask_explanation',
                      'unknown',
                    ],
                  },
                  entityType: {
                    type: ['string', 'null'],
                    enum: ['point', 'device', 'panel', null],
                  },
                  entityKind: {
                    type: ['string', 'null'],
                  },
                  quantity: {
                    type: ['number', 'null'],
                  },
                  routeLengthMeters: {
                    type: ['number', 'null'],
                  },
                  wallType: {
                    type: ['string', 'null'],
                    enum: ['brick', 'concrete', 'drywall', 'none', null],
                  },
                  field: {
                    type: ['string', 'null'],
                    enum: ['quantity', 'routeLengthMeters', 'wallType', null],
                  },
                  value: {
                    type: ['string', 'number', 'null'],
                  },
                  notes: {
                    type: ['string', 'null'],
                  },
                },
              },
            },
          },
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        this.logger.warn(
          `mini extractor failed status=${res.status} body=${text}`
        );
        return { action: 'unknown' };
      }

      const json = (await res.json()) as {
        output_text?: string;
        output?: Array<{
          content?: Array<{
            type?: string;
            text?: string;
          }>;
        }>;
      };

      const textFromTopLevel =
        typeof json.output_text === 'string' ? json.output_text : undefined;

      const textFromOutput = json.output
        ?.flatMap((item) => item.content ?? [])
        .find((item) => item.type === 'output_text' && typeof item.text === 'string')
        ?.text;

      const rawText = textFromTopLevel ?? textFromOutput ?? '{}';

      this.logger.log(
        `mini extractor rawText=${rawText} message="${input.message}"`
      );

      const parsed = JSON.parse(rawText) as AssistantExtraction;

      this.logger.log(
        `mini extractor action=${parsed.action ?? 'missing'} message="${input.message}"`
      );

      if (!parsed.action) {
        return { action: 'unknown', notes: rawText };
      }

      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`mini extractor exception: ${message}`);
      return { action: 'unknown' };
    }
  }

  private buildMiniExtractorPrompt(input: {
    message: string;
    draft?: AssistantEstimateDraft;
  }): string {
    return [
      'You extract structured estimator intent from a user message.',
      'Return JSON only.',
      'Allowed actions: set_scope, add_scope, fill_missing_field, ask_explanation, unknown.',
      'Allowed entityType: point, device, panel.',
      'Allowed entityKind:',
      '- power_point',
      '- low_current_point',
      '- socket_or_switch_concealed',
      '- socket_or_switch_surface',
      '- three_phase_socket',
      '- bathroom_fan',
      '- motion_sensor',
      '- internet_outlet',
      '- light_fixture_basic',
      '- boiler_connection',
      '- stove_connection',
      '- ac_connection',
      '- apartment_panel_up_to_4',
      '- apartment_panel_up_to_8',
      '- apartment_panel_above_8',
      '- boiler_panel',
      'Rules:',
      '- boiler or бойлер => boiler_connection',
      '- stove, pechka, pe4ka, печка, фурна, котлон => stove_connection',
      '- ac, climate, klimatik, климатик => ac_connection',
      '- if user asks how it was calculated => ask_explanation',
      '- if user gives only a number and there is an existing draft, prefer fill_missing_field',
      '- if uncertain => unknown',
      'Return only one JSON object.',
      'Do not wrap the JSON in markdown.',
      'Always include the action field.',
      `Current draft: ${input.draft ? JSON.stringify(input.draft) : 'none'}`,
      `User message: ${input.message}`,
    ].join('\n');
  }

  private detectOperation(
    message: string,
    hasDraft: boolean
  ): AssistantStepResult['operation'] {
    const text = this.normalizeOperationText(message);

    if (
      /(как|kak|пресм|presm|изчис|izchisl|логик|logic|защо|zasho|за6то|формира|formira|образува|obrazuva|сметн|smetn)/i.test(
        text
      )
    ) {
      return 'explain';
    }

    if (hasDraft && /(общо|obshto|тотал|total|sum|сума)/i.test(text)) {
      return 'summarize';
    }

    if (hasDraft && /(добав|dobav|още|oshte|plus|плюс)/i.test(text)) {
      return 'add_item';
    }

    if (
      hasDraft &&
      /(махни|mahni|премахни|premahni|remove|delete)/i.test(text)
    ) {
      return 'remove_item';
    }

    return hasDraft ? 'update_item' : 'start_estimate';
  }

  private buildExplanation(
    draft: AssistantEstimateDraft,
    preview: ReturnType<typeof estimateProject>
  ): AssistantStepExplanation {
    const steps: string[] = [];

    for (const point of draft.points) {
      const qty = point.quantity ?? 0;
      const meters = point.routeLengthMeters ?? 0;
      const pointLabel =
        point.kind === 'low_current_point'
          ? 'слаботокови точки'
          : 'силови точки';

      steps.push(`Добавени са ${qty} ${pointLabel} с трасе ${meters} м.`);

      if (point.wallType && point.wallType !== 'none') {
        const wallLabel =
          point.wallType === 'brick'
            ? 'тухла'
            : point.wallType === 'concrete'
              ? 'бетон'
              : 'гипсокартон';
        steps.push(`Тип стена: ${wallLabel}.`);
      }
    }

    for (const device of draft.devices) {
      steps.push(
        `Добавени са ${device.quantity ?? 0} бр. ${this.labelDevice(device.kind)}.`
      );
    }

    for (const panel of draft.panels) {
      steps.push(
        `Добавени са ${panel.quantity ?? 0} бр. ${this.labelPanel(panel.kind)}.`
      );
    }

    for (const line of preview.lines) {
      steps.push(
        `${line.label}: ${line.quantity} ${line.unit} × ${line.unitPrice.toFixed(2)} = ${line.subtotal.toFixed(2)} EUR.`
      );
    }

    for (const assumption of preview.assumptions ?? []) {
      steps.push(`Допускане: ${assumption}`);
    }

    return {
      steps,
      summaryBg: `Изчислението е направено по текущата чернова и ценовия каталог. Общо: ${preview.subtotal.toFixed(2)} ${preview.currency}.`,
    };
  }

  private normalizeOperationText(message: string): string {
    return message
      .toLowerCase()
      .trim()
      .replace(/6/g, 'ш')
      .replace(/4/g, 'ч')
      .replace(/q/g, 'я')
      .replace(/x/g, 'ж')
      .replace(/smetnahte/g, 'сметнахте')
      .replace(/smetna/g, 'сметна')
      .replace(/smetnali/g, 'сметнали')
      .replace(/kak/g, 'как')
      .replace(/zasho/g, 'защо')
      .replace(/dobavi/g, 'добави')
      .replace(/mahni/g, 'махни')
      .replace(/obshto/g, 'общо')
      .replace(/presmet/g, 'пресмет')
      .replace(/izchisl/g, 'изчисл')
      .replace(/\s+/g, ' ');
  }

  private formatExplanationReply(explanation: AssistantStepExplanation): string {
    const topSteps = explanation.steps.slice(0, 4);

    return [
      explanation.summaryBg,
      '',
      ...topSteps.map((step, index) => `${index + 1}. ${step}`),
    ]
      .filter(Boolean)
      .join('\n');
  }

  private labelDevice(kind: string): string {
    switch (kind) {
      case 'socket_or_switch_concealed':
        return 'контакт / ключ';
      case 'socket_or_switch_surface':
        return 'контакт / ключ открит монтаж';
      case 'three_phase_socket':
        return 'трифазен контакт';
      case 'bathroom_fan':
        return 'вентилатор за баня';
      case 'light_fixture_basic':
        return 'осветително тяло';
      case 'motion_sensor':
        return 'датчик за движение';
      case 'internet_outlet':
        return 'интернет розетка';
      case 'boiler_connection':
        return 'бойлер';
      case 'stove_connection':
        return 'печка';
      case 'ac_connection':
        return 'климатик';
      default:
        return kind;
    }
  }

  private labelPanel(kind: string): string {
    switch (kind) {
      case 'apartment_panel_up_to_4':
        return 'апартаментно табло до 4 кръга';
      case 'apartment_panel_up_to_8':
        return 'апартаментно табло до 8 кръга';
      case 'apartment_panel_above_8':
        return 'апартаментно табло над 8 кръга';
      case 'boiler_panel':
        return 'бойлерно табло';
      default:
        return kind;
    }
  }

  private formatPreviewReply(preview: {
    subtotal: number;
    currency: string;
    assumptions: string[];
    needsInspection: boolean;
  }): string {
    const subtotalText = `${preview.subtotal.toFixed(2)} ${preview.currency}`;
    const assumptions = preview.assumptions ?? [];

    const materialNote = assumptions.some((x) =>
      x.toLowerCase().includes('материалите не са включени')
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
