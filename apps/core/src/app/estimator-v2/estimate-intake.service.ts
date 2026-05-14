import { Injectable, Logger } from '@nestjs/common';
import type { EstimateConversationDraft } from './estimate-draft.types';
import type { EstimateJobType, EstimateUpdate } from './estimate-intake.types';

@Injectable()
export class EstimateIntakeService {
  private readonly logger = new Logger(EstimateIntakeService.name);

  async extractEstimateUpdate(input: {
    message: string;
    draft?: EstimateConversationDraft | null;
  }): Promise<EstimateUpdate> {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_SMALL_MODEL || 'gpt-4.1-mini';

    if (!apiKey) {
      this.logger.warn('OPENAI_API_KEY missing; returning unknown estimate update');
      return {
        updates: {},
        askExplanation: false,
        userIntent: 'unknown',
        scopeSwitch: false,
      };
    }

    const forcedJobType = this.getForcedJobType(input);
    const prompt = this.buildPrompt(input, forcedJobType);

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
              name: 'estimate_update',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  jobType: {
                    type: ['string', 'null'],
                    enum: [
                      'boiler_installation',
                      'boiler_replacement',
                      'stove_installation',
                      'ac_installation',
                      'points',
                      'panel',
                      null,
                    ],
                  },
                  updates: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      quantity: { type: ['number', 'null'] },
                      routeLengthMeters: { type: ['number', 'null'] },
                      wallType: {
                        type: ['string', 'null'],
                        enum: ['brick', 'concrete', 'none', null],
                      },
                      powerSource: {
                        type: ['string', 'null'],
                        enum: ['panel', 'existing_line', null],
                      },
                      panelKind: {
                        type: ['string', 'null'],
                        enum: [
                          'boiler_panel',
                          'apartment_panel_up_to_4',
                          'apartment_panel_up_to_8',
                          'apartment_panel_above_8',
                          null,
                        ],
                      },
                      replacement: { type: ['boolean', 'null'] },
                      connectionMode: {
                        type: ['string', 'null'],
                        enum: ['existing_cable_only', 'new_line_required', null],
                      },
                    },
                    required: [
                      'quantity',
                      'routeLengthMeters',
                      'wallType',
                      'powerSource',
                      'panelKind',
                      'replacement',
                      'connectionMode',
                    ],
                  },
                  askExplanation: { type: ['boolean', 'null'] },
                  userIntent: {
                    type: ['string', 'null'],
                    enum: ['estimate', 'followup', 'explanation', 'unknown', null],
                  },
                  scopeSwitch: { type: ['boolean', 'null'] },
                },
                required: [
                  'jobType',
                  'updates',
                  'askExplanation',
                  'userIntent',
                  'scopeSwitch',
                ],
              },
            },
          },
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        this.logger.warn(`estimate update extraction failed status=${res.status} body=${text}`);
        return {
          updates: {},
          askExplanation: false,
          userIntent: 'unknown',
          scopeSwitch: false,
        };
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
        '{}';

      this.logger.log(`estimate update rawText=${rawText} message="${input.message}"`);

      const parsed = JSON.parse(rawText) as EstimateUpdate;

      const normalized: EstimateUpdate = {
        jobType: (forcedJobType ?? parsed.jobType) ?? undefined,
        updates: {},
        askExplanation: parsed.askExplanation ?? false,
        userIntent: parsed.userIntent ?? 'unknown',
        scopeSwitch: parsed.scopeSwitch ?? false,
      };

      const u = parsed.updates ?? {};

      if (typeof u.quantity === 'number') {
        normalized.updates.quantity = u.quantity;
      }

      if (typeof u.routeLengthMeters === 'number') {
        normalized.updates.routeLengthMeters = u.routeLengthMeters;
      }

      if (u.wallType) {
        normalized.updates.wallType = u.wallType;
      }

      if (u.powerSource) {
        normalized.updates.powerSource = u.powerSource;
      }

      if (u.panelKind) {
        normalized.updates.panelKind = u.panelKind;
      }

      if (typeof u.replacement === 'boolean') {
        normalized.updates.replacement = u.replacement;
      }

      if (u.connectionMode) {
        normalized.updates.connectionMode = u.connectionMode;
      }

      if (!input.draft && normalized.askExplanation) {
        normalized.askExplanation = false;
      }

      if (
        normalized.jobType === 'boiler_installation' &&
        normalized.updates.replacement === true
      ) {
        normalized.jobType = 'boiler_replacement';
      }

      return normalized;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`estimate update extraction exception: ${message}`);
      return {
        updates: {},
        askExplanation: false,
        userIntent: 'unknown',
        scopeSwitch: false,
      };
    }
  }

  private getForcedJobType(input: {
    message: string;
    draft?: EstimateConversationDraft | null;
  }): EstimateJobType | undefined {
    const currentJobType = input.draft?.jobType;
    if (!currentJobType) {
      return undefined;
    }

    const text = input.message.trim().toLowerCase();

    const clearlySwitchesToStove =
      /(печка|pechka|pe4ka|котлон|kotlon|плот|plo[t4]a|фурна|furna)/i.test(text);

    const clearlySwitchesToAc =
      /(климатик|klimatik|climate|ac)\b/i.test(text);

    const clearlySwitchesToPanel =
      /(табло|tablo)\b/i.test(text);

    const clearlySwitchesToPoints =
      /(контакт|контакти|contact|contacts|точка|точки|tochka|tochki|кабели|kabeli|окабеляване)/i.test(
        text,
      ) && !/(бойлер|boiler|печка|pechka|pe4ka|котлон|kotlon|плот|plo[t4]a|фурна|furna|климатик|klimatik)/i.test(text);

    if (
      clearlySwitchesToStove ||
      clearlySwitchesToAc ||
      clearlySwitchesToPanel ||
      clearlySwitchesToPoints
    ) {
      return undefined;
    }

    const looksLikeShortAnswer =
      text.length <= 28 ||
      /^\d+(?:[.,]\d+)?(?:\s*(?:m|m\.|metra|метра|метър|метри))?$/i.test(text) ||
      /^(da|ne|yes|no)$/i.test(text) ||
      /^(ot tabloto|има kabel|ima kabel|bez kurtene|samo smqna|samo da se podmeni|ima star boiler|star boiler|ima veche kabel|veche izvadena liniq)$/i.test(
        text,
      );

    if (looksLikeShortAnswer) {
      return currentJobType;
    }

    return undefined;
  }

  private buildPrompt(
    input: {
      message: string;
      draft?: EstimateConversationDraft | null;
    },
    forcedJobType?: EstimateJobType,
  ): string {
    return [
      'You extract DELTA estimate updates from customer messages for an electrical installation assistant.',
      'Treat the message as raw customer input only.',
      'Return JSON only.',
      'Only include fields learned from THIS message.',
      'Do not restate old known values from the draft unless the user explicitly changes them.',
      'If the message only adds one thing, return only that one thing in updates.',
      '',
      'Allowed job types:',
      '- boiler_installation',
      '- boiler_replacement',
      '- stove_installation',
      '- ac_installation',
      '- points',
      '- panel',
      '',
      'Intent rules:',
      '- first-message price questions like "cena", "price", "kolko struva", "kolko e" are estimate requests, not explanation requests',
      '- set askExplanation=true only when the user asks why an ALREADY GIVEN estimate is calculated that way',
      '- examples of explanation: "zashto", "kak go smetna", "obqsni cenata", but only if there is already a real estimate/draft context',
      '',
      'Job-type rules:',
      '- бойлер / boiler => boiler_installation unless the message clearly indicates replacement',
      '- if the user says they already have a boiler and want to replace / change it, use boiler_replacement',
      '- examples for boiler_replacement: "imam star boiler", "smqna", "podmqna", "zamenq stariq s nov", "samo da se podmeni", "replace old boiler"',
      '- печка / pechka / pe4ka / фурна / furna / котлон / kotlon / плот / plot / plo4a => stove_installation',
      '- климатик / klimatik / climate / ac => ac_installation',
      '- sockets, contacts, points, cables, whole apartment new wiring => points',
      '- panel / tablo / табло => panel',
      '',
      'Critical continuity rules:',
      '- if there is an existing draft topic and the new message is short, numeric, or clearly an answer to a previous question, keep the same jobType',
      '- current boiler_installation + "4 metra" => keep boiler_installation and set only routeLengthMeters=4',
      '- current boiler_installation + "ima kabel" => keep boiler_installation and set only connectionMode=existing_cable_only',
      '- if the new message clearly mentions stove words (pechka, kotlon, plot, furna), switch to stove_installation even if previous draft was boiler',
      '- if the new message clearly mentions AC or panel words, switch topic accordingly',
      '',
      'Interpret uncertain language aggressively:',
      '- phrases like "мисля", "май", "вероятно", "probably" still count as usable signals',
      '- "мисля че кабела е добър" => connectionMode=existing_cable_only',
      '- "има кабел", "има вече кабел", "вече изведена линия" => connectionMode=existing_cable_only',
      '- "от таблото", "нова линия", "нова линия от таблото" => powerSource=panel and/or connectionMode=new_line_required',
      '- "май няма да се кърти" => wallType=none',
      '- prefer best guess over empty update when the user strongly implies reuse of existing infrastructure',
      '',
      'Extraction rules:',
      '- if user says they already have one boiler and want replacement, set quantity=1 unless they clearly say otherwise',
      '- do not invent panelKind from building type phrases like "panelen apartament"',
      '- if the user does not explicitly provide panelKind, leave it null',
      '- do not invent fields outside schema',
      '',
      forcedJobType
        ? `Forced current jobType: ${forcedJobType}. Keep this jobType unless the user clearly changes topic.`
        : 'Forced current jobType: none.',
      `Current draft: ${input.draft ? JSON.stringify(input.draft) : 'none'}`,
      `User message: ${input.message}`,
    ].join('\\n');
  }
}
