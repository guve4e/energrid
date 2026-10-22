import {
  routeLightingIntent,
  type LightingRoomAlias,
} from './lighting-intent-router';

const rooms: LightingRoomAlias[] = [
  {
    roomId: 'kitchen',
    aliases: ['кухнята', 'кухня'],
  },
  {
    roomId: 'living-room',
    aliases: ['хола', 'дневната'],
  },
];

describe('Bulgarian lighting intent router', () => {
  describe('explicit commands', () => {
    it.each([
      ['Светни лампата в кухнята.', 'turn_on', 'kitchen'],
      ['Включи лампите в кухнята', 'turn_on', 'kitchen'],
      ['Пусни осветлението в кухнята', 'turn_on', 'kitchen'],
      ['Енергрид, включи лампата в кухнята.', 'turn_on', 'kitchen'],
      ['Хей Енергрид, светни лампите в кухнята!', 'turn_on', 'kitchen'],
      ['Моля, включи лампата в кухнята.', 'turn_on', 'kitchen'],
      ['Можеш ли да включиш лампата в кухнята?', 'turn_on', 'kitchen'],
      ['Изгаси лампата в кухнята.', 'turn_off', 'kitchen'],
      ['Изключи осветлението в кухнята', 'turn_off', 'kitchen'],
      ['Спри лампите в кухнята', 'turn_off', 'kitchen'],
      ['Светни лампата в хола', 'turn_on', 'living-room'],
      ['Изгаси лампите в дневната', 'turn_off', 'living-room'],
    ] as const)(
      '%s',
      (utterance, action, roomId) => {
        expect(routeLightingIntent(utterance, rooms)).toEqual({
          kind: 'fast_action',
          action,
          roomId,
          loadType: 'lighting',
        });
      },
    );
  });

  describe('fail-closed routing', () => {
    it.each([
      'Не включвай лампата в кухнята.',
      'Енергрид, не светвай лампата в кухнята.',
      'Можеш ли да не включиш лампата в кухнята?',
      'Светни лампата.',
      'Светни тук.',
      'Включи лампата в спалнята.',
      'Включи лампата в кухнята и в хола.',
      'Включи лампата в кухнята и изключи тази в хола.',
      'Включи лампата в кухнята, но не сега.',
      'Защо лампата в кухнята не работи?',
      'Кога последно светнахме лампите?',
      'Какво е времето в кухнята?',
      'Настрой термопомпата на 35 градуса.',
      'Включи всички устройства в кухнята.',
      '',
    ])('never auto-executes: %s', utterance => {
      expect(
        routeLightingIntent(utterance, rooms).kind,
      ).toBe('delegate');
    });

    it('rejects missing trusted room configuration', () => {
      expect(
        routeLightingIntent(
          'Светни лампата в кухнята',
          [],
        ).kind,
      ).toBe('delegate');
    });

    it('rejects conflicting room identities', () => {
      const conflicting: LightingRoomAlias[] = [
        { roomId: 'kitchen-a', aliases: ['кухнята'] },
        { roomId: 'kitchen-b', aliases: ['кухнята'] },
      ];

      expect(
        routeLightingIntent(
          'Светни лампата в кухнята',
          conflicting,
        ),
      ).toEqual({
        kind: 'delegate',
        reason: 'ambiguous',
      });
    });

    it('does not interpret multiple sentences as one command', () => {
      const result = routeLightingIntent(
        'Включи лампата в кухнята. После изключи лампата в хола.',
        rooms,
      );

      expect(result.kind).toBe('delegate');
    });

    it('rejects oversized messages', () => {
      expect(
        routeLightingIntent(
          'Светни '.repeat(300),
          rooms,
        ).kind,
      ).toBe('delegate');
    });
  });
});
