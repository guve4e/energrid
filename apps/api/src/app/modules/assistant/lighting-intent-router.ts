export interface LightingRoomAlias {
  roomId: string;
  aliases: readonly string[];
}

export type LightingIntentRoute =
  | {
      kind: 'fast_action';
      action: 'turn_on' | 'turn_off';
      roomId: string;
      loadType: 'lighting';
    }
  | {
      kind: 'delegate';
      reason: 'ambiguous' | 'unsupported';
    };

const ON_VERBS = new Set([
  'включи', 'включиш',
  'пусни', 'пуснеш',
  'светни', 'светнеш',
  'запали', 'запалиш',
]);

const OFF_VERBS = new Set([
  'изключи', 'изключиш',
  'изгаси', 'изгасиш',
  'спри', 'спреш',
]);

const LIGHTING_COMMAND =
  /^(включи|включиш|пусни|пуснеш|светни|светнеш|запали|запалиш|изключи|изключиш|изгаси|изгасиш|спри|спреш)\s+(лампата|лампите|осветлението|светлината)(?:\s+(?:в|във)\s+(.+))?$/u;

const ACTION_WORD =
  /(?:^|\s)(?:включи|включиш|пусни|пуснеш|светни|светнеш|запали|запалиш|изключи|изключиш|изгаси|изгасиш|спри|спреш)(?=\s|$)/u;

function normalize(value: string): string {
  return value
    .normalize('NFC')
    .toLocaleLowerCase('bg-BG')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Conservative intent extraction, not device authorization.
 *
 * Returns fast_action only for a complete, explicitly scoped
 * lighting command. Room aliases must come from trusted Core
 * installation data when this is integrated.
 *
 * No LLM calls, device reads, or physical side effects.
 */
export function routeLightingIntent(
  input: string,
  rooms: readonly LightingRoomAlias[],
): LightingIntentRoute {
  if (typeof input !== 'string' || input.length > 1000) {
    return { kind: 'delegate', reason: 'unsupported' };
  }

  let text = normalize(input);

  if (!text) {
    return { kind: 'delegate', reason: 'unsupported' };
  }

  // Trailing sentence punctuation is harmless, but punctuation
  // inside a command is NOT removed or silently reinterpreted.
  text = text.replace(/[.!?]+$/u, '').trim();

  // Optional wake word.
  text = text.replace(
    /^(?:(?:хей|ей)\s+)?(?:енергрид|energrid)[,:]?\s+/u,
    '',
  );

  // Supported polite request forms.
  text = text.replace(
    /^(?:моля[,\s]+|можеш ли да\s+|би ли\s+)/u,
    '',
  );

  // Do not strip negation, subordinate clauses, or extra actions.
  // The whole remaining utterance must match the grammar.
  const match = LIGHTING_COMMAND.exec(text);

  if (!match) {
    return {
      kind: 'delegate',
      reason: ACTION_WORD.test(text)
        ? 'ambiguous'
        : 'unsupported',
    };
  }

  const verb = match[1];
  const roomPhrase = match[3];

  if (!roomPhrase) {
    return { kind: 'delegate', reason: 'ambiguous' };
  }

  const matchingRooms = rooms.filter(room =>
    room.roomId.trim().length > 0 &&
    room.aliases.some(alias =>
      normalize(alias) === roomPhrase,
    ),
  );

  // Fail closed if unknown OR multiply assigned.
  if (matchingRooms.length !== 1) {
    return { kind: 'delegate', reason: 'ambiguous' };
  }

  const action = ON_VERBS.has(verb)
    ? 'turn_on'
    : OFF_VERBS.has(verb)
      ? 'turn_off'
      : null;

  if (!action) {
    return { kind: 'delegate', reason: 'unsupported' };
  }

  return {
    kind: 'fast_action',
    action,
    roomId: matchingRooms[0].roomId,
    loadType: 'lighting',
  };
}
