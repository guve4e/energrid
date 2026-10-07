import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { EstimateConversationDraft } from './estimate-draft.types';
import type { EstimateJobType, EstimateUpdate } from './estimate-intake.types';

@Injectable()
export class EstimateIntakeService {
  private readonly logger = new Logger(EstimateIntakeService.name);

  async extractEstimateUpdate(input: {
    message: string;
    customerHistory?: string[];
    draft?: EstimateConversationDraft | null;
  }): Promise<EstimateUpdate> {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_SMALL_MODEL || 'gpt-4.1-mini';

    if (!apiKey) throw new ServiceUnavailableException('Estimate assistant is not configured');

    const forcedJobType = this.getForcedJobType(input);
    const prompt = this.buildPrompt(input, forcedJobType);

    try {
      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        signal: AbortSignal.timeout(20000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          store: false,
          max_output_tokens: 700,
          instructions: prompt,
          input: JSON.stringify({ draft: input.draft ?? null, customerHistory: input.customerHistory ?? [], message: input.message }),
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
                      'residential_installation',
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
                      propertyType: { type: ['string', 'null'], enum: ['studio', 'apartment', 'house', null] },
                      areaSqm: { type: ['number', 'null'] },
                      buildingStage: { type: ['string', 'null'], enum: ['new', 'renovation', null], description: 'New construction versus renovation. In a dwelling conversation, Novo 30 kvadrata means new construction and 30 square metres. A request for a new installation alone does not establish construction stage.' },
                      hasBoiler: { type: ['boolean', 'null'] },
                      hasAc: { type: ['boolean', 'null'] },
                      acCount: { type: ['number', 'null'] },
                      roomCount: { type: ['number', 'null'] },
                      corridorCount: { type: ['number', 'null'] },
                      bathroomCount: { type: ['number', 'null'] },
                      terraceCount: { type: ['number', 'null'] },
                      socketCount: { type: ['number', 'null'] },
                      lightingPointCount: { type: ['number', 'null'] },
                      smartRelayCount: { type: ['number', 'null'] },
                      separateKitchen: { type: ['boolean', 'null'] },
                      hasOven: { type: ['boolean', 'null'] },
                      hasHob: { type: ['boolean', 'null'] },
                      hasDryer: { type: ['boolean', 'null'] },
                      hasDishwasher: { type: ['boolean', 'null'] },
                      hasCooker: { type: ['boolean', 'null'] },
                      hasWashingMachine: { type: ['boolean', 'null'] },
                      planAccepted: { type: ['boolean', 'null'] },
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
                          'panel_standard', 'panel_modern', 'panel_full_protection', 'panel_custom',
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
                      'corridorCount', 'bathroomCount', 'terraceCount',
                      'propertyType', 'areaSqm', 'buildingStage', 'hasBoiler', 'hasAc', 'acCount', 'roomCount', 'socketCount', 'lightingPointCount', 'smartRelayCount', 'separateKitchen', 'hasOven', 'hasHob', 'hasDryer', 'hasDishwasher', 'hasCooker', 'hasWashingMachine', 'planAccepted',
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
        throw new Error(`Estimate extraction failed: ${res.status}`);
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


      const parsed = JSON.parse(rawText) as EstimateUpdate;
      if (!parsed || typeof parsed.updates !== 'object' || !parsed.updates) {
        throw new Error('Incomplete estimate extraction');
      }

      const normalized: EstimateUpdate = {
        jobType: (forcedJobType ?? parsed.jobType) ?? undefined,
        updates: {},
        askExplanation: parsed.askExplanation ?? false,
        userIntent: parsed.userIntent ?? 'unknown',
        scopeSwitch: parsed.scopeSwitch ?? false,
      };

      const u = parsed.updates ?? {};
      for (const field of ['corridorCount', 'bathroomCount', 'terraceCount'] as const) {
        if (u[field] != null) normalized.updates[field] = u[field];
      }
      for (const field of ['propertyType', 'areaSqm', 'buildingStage', 'hasBoiler', 'hasAc', 'acCount', 'roomCount', 'socketCount', 'lightingPointCount', 'smartRelayCount', 'separateKitchen', 'hasOven', 'hasHob', 'hasDryer', 'hasDishwasher', 'hasCooker', 'hasWashingMachine', 'planAccepted'] as const) {
        if (u[field] != null) (normalized.updates as Record<string, unknown>)[field] = u[field];
      }
      if (u.quantity != null && (typeof u.quantity !== 'number' || !Number.isInteger(u.quantity) || u.quantity <= 0 || u.quantity > 10000)) throw new Error('Invalid extracted quantity');
      if (u.routeLengthMeters != null && (typeof u.routeLengthMeters !== 'number' || !Number.isFinite(u.routeLengthMeters) || u.routeLengthMeters < 0 || u.routeLengthMeters > 10000)) throw new Error('Invalid extracted route length');

      if (typeof u.quantity === 'number' && Number.isInteger(u.quantity) && u.quantity > 0 && u.quantity <= 10000) {
        normalized.updates.quantity = u.quantity;
      }

      if (typeof u.routeLengthMeters === 'number' && Number.isFinite(u.routeLengthMeters) && u.routeLengthMeters >= 0 && u.routeLengthMeters <= 10000) {
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
      this.logger.warn('Estimate extraction failed; customer message was not logged');
      throw new ServiceUnavailableException('Estimate assistant temporarily unavailable; please retry');
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
    // Only unambiguous short answers lock the old topic. A new named job may switch it.
    return /^(?:\d+(?:[.,]\d+)?(?:\s*(?:m|м|метра|бр\.?))?|да|не|yes|no)$/.test(text) ? currentJobType : undefined;
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
      'Only include fields learned from THIS message. Exception: if no draft exists, also extract facts from customerHistory (customer messages only).',
      'Bulgarian in Latin letters, misspellings and digits used as letters are valid customer input.',
      'A village-house renovation is residential_installation: ku6ta/kushta means house, remont na selo means renovation in a village. Never invent room counts from uncertain spelling: "s ve stai" is ambiguous (possibly "s dve stai"), NOT five rooms. Leave roomCount null and clarify. "dve stai" means two living rooms; five is "pet stai". A bathroom, kitchen and corridor are separate ancillary spaces. Full replacement is suggested by "vsi4ko novo". Only customer history provides facts; do not use guesses from assistant replies.',
      'Residential example: "Novo 30 kvadrata.. standartna si garsionera" updates buildingStage=new, areaSqm=30, propertyType=studio. Do not ask again for facts already stated.',
      'A whole dwelling installation is residential_installation. Garsoniera, garsionera and Garisionerata mean studio. kvadrata means square metres, not points.',
      'Preserve a listed layout: Staq, koridor, banq, kiuhnq, terasa means roomCount=1, corridorCount=1, bathroomCount=1, separateKitchen=true, terraceCount=1. This is five lighting spaces, not five living rooms. Never invent square metres from the word studio. A terrace/balcony counts as its own lighting space. Explicit no terrace means terraceCount=0.',
      'In a residential draft, boiler and AC answers update hasBoiler/hasAc; do not switch to appliance installation.',
      'currentQuestionField=kitchenAppliances means the assistant asked whether there will be both a cooker and a washing machine. A clear yes confirms hasCooker and hasWashingMachine, not planAccepted. For hasCooker/hasWashingMachine, bind yes/no to that field.',
      'Keep residential_installation for follow-up answers unless the customer explicitly abandons the whole dwelling job.',
      'Set planAccepted=true only for explicit acceptance of an already proposed residential plan. Any changed residential fact sets planAccepted=false.',
      'Do not restate old known values from the draft unless the user explicitly changes them.',
      'If the message only adds one thing, return only that one thing in updates.',
      'Distinguish questions from instructions: "Umno rele, tova za kakvo e" is an explanation request, not a purchase or an instruction to add smartRelayCount=1. "trqbva li da se kurtqt stenite" asks about chasing; do not set wallType or quantities. For a pure information question set userIntent=explanation, askExplanation=true, all updates null and scopeSwitch=false. Mixed messages with explicit requested changes are followup and update only explicitly requested facts. Mentioning an item in a question never means ordering it.',
      '',
      'Allowed job types:',
      '- residential_installation',
      '- boiler_installation',
      '- boiler_replacement',
      '- stove_installation',
      '- ac_installation',
      '- points',
      '- panel',
      '',
      'Intent rules:',
      '- first-message price questions like "cena", "price", "kolko struva", "kolko e" are estimate requests, not explanation requests',
      '- set askExplanation=true when the user asks why an estimate, proposal, or intake question was given, including complaints such as togava za kakvo me pita za klimatik i boiler.',
      'For residential installations, extract roomCount from tristaen/тристаен=3, dvustaen=2 (living rooms including living room, excluding bathroom/corridor). Extract separateKitchen only if stated. socketCount and lightingPointCount are whole-home totals only when explicit. Preserve hasOven, hasHob, hasDryer, hasDishwasher and smartRelayCount; zero means none. Never invent quantities; backend supplies labelled defaults.',
      'Preserve explicit residential AC counts: 4 klimatika means hasAc=true and acCount=4. Never infer counts from silence. remont means renovation; reuse facts from customerHistory.',
      '- examples of explanation: "zashto", "kak go smetna", "obqsni cenata", but only if there is already a real estimate/draft context',
      '',
      'Job-type rules:',
      '- бойлер / boiler => boiler_installation unless the message clearly indicates replacement',
      '- if the user says they already have a boiler and want to replace / change it, use boiler_replacement',
      '- examples for boiler_replacement: "imam star boiler", "smqna", "podmqna", "zamenq stariq s nov", "samo da se podmeni", "replace old boiler"',
      '- печка / pechka / pe4ka / фурна / furna / котлон / kotlon / плот / plot / plo4a => stove_installation',
      '- климатик / klimatik / climate / ac => ac_installation',
      '- sockets, contacts, points, cables, whole apartment new wiring => residential_installation',
      '- panel / tablo / табло => panel. panel_standard=MCB only; panel_modern=MCB with RCD groups; panel_full_protection=SPD, voltage relay and RCBO; panel_custom=individual design. Never select protection level without customer confirmation.',
      '',
      'Critical continuity rules:',
      '- if there is an existing draft topic and the new message is short, numeric, or clearly an answer to a previous question, keep the same jobType',
      '- current boiler_installation + "4 metra" => keep boiler_installation and set only routeLengthMeters=4',
      '- current boiler_installation + "ima kabel" => keep boiler_installation and set only connectionMode=existing_cable_only',
      '- if the new message clearly mentions stove words (pechka, kotlon, plot, furna), switch to stove_installation even if previous draft was boiler',
      '- Switch job only for an explicit new task. An answer like "from the panel" describes powerSource, not a panel installation.',
      '',
      'Never guess unspecified quantities, route lengths, wall types or cable suitability.',
      'Uncertain phrases (probably, мисля, май, not sure) are not confirmed specifications; leave the affected field null.',
      'A ready cable means existing_cable_only only if the customer explicitly says to reuse it.',
      'Only set scopeSwitch=true when replacing the current job, never for an answer to a follow-up.',
      'Do not turn an apartment area into a count of points. Ask for the actual count.',
      'Extraction rules:',
      '- Set quantity only from an explicit count; do not default to one.',
      '- do not invent panelKind from building type phrases like "panelen apartament"',
      '- if the user does not explicitly provide panelKind, leave it null',
      '- do not invent fields outside schema',
      '',
      forcedJobType
        ? `Forced current jobType: ${forcedJobType}. Keep this jobType unless the user clearly changes topic.`
        : 'Forced current jobType: none.',
    ].join('\n');
  }
}
