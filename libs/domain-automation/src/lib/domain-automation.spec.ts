import {
  classifyHomeIntent,
  HomeContext,
  planHomeIntent,
} from './domain-automation'

const baseContext: HomeContext = {
  outsideDark: false,
  insideTempC: 21,
  targetTempC: 21,
  comfortTempC: 22,
  homeMode: 'away',
  availableDevices: [
    'entry_light',
    'hallway_light',
    'kitchen_light',
    'thermostat',
  ],
  occupiedRooms: [],
  alarmArmed: false,
}

describe('planHomeIntent', () => {
  it('turns on arrival lights and raises temperature when user comes home after dark', () => {
    const plan = planHomeIntent({
      intent: 'arrival_home',
      context: {
        ...baseContext,
        outsideDark: true,
        insideTempC: 19,
      },
    })

    expect(plan.intent).toBe('arrival_home')
    expect(plan.requiresConfirmation).toBe(false)
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'mode.set', value: 'home' }),
        expect.objectContaining({ type: 'light.turn_on', deviceId: 'entry_light' }),
        expect.objectContaining({ type: 'light.turn_on', deviceId: 'hallway_light' }),
        expect.objectContaining({ type: 'light.turn_on', deviceId: 'kitchen_light' }),
        expect.objectContaining({
          type: 'thermostat.set_target',
          value: 22,
        }),
      ]),
    )
    expect(plan.spokenReply).toContain('Навън е тъмно')
    expect(plan.spokenReply).toContain('22 градуса')
  })

  it('does not turn on lights on arrival when outside is not dark', () => {
    const plan = planHomeIntent({
      intent: 'arrival_home',
      context: {
        ...baseContext,
        outsideDark: false,
        insideTempC: 21.8,
      },
    })

    expect(plan.actions).toEqual([
      expect.objectContaining({ type: 'mode.set', value: 'home' }),
    ])
    expect(plan.spokenReply).not.toContain('Навън е тъмно')
  })

  it('requires confirmation before disarming alarm on arrival', () => {
    const plan = planHomeIntent({
      intent: 'arrival_home',
      context: {
        ...baseContext,
        alarmArmed: true,
      },
    })

    expect(plan.requiresConfirmation).toBe(true)
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        type: 'alarm.disarm',
        risk: 'confirmation_required',
      }),
    )
    expect(plan.spokenReply).toContain('потвърждение')
  })

  it('turns off non-essential lights when leaving home', () => {
    const plan = planHomeIntent({
      intent: 'leaving_home',
      context: baseContext,
    })

    expect(plan.requiresConfirmation).toBe(false)
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'mode.set', value: 'away' }),
        expect.objectContaining({ type: 'light.turn_off', deviceId: 'entry_light' }),
        expect.objectContaining({ type: 'light.turn_off', deviceId: 'hallway_light' }),
        expect.objectContaining({ type: 'light.turn_off', deviceId: 'kitchen_light' }),
      ]),
    )
  })

  it('targets requested bathroom lights from Bulgarian transliteration', () => {
    const plan = planHomeIntent({
      intent: 'turn_on_lights',
      context: {
        ...baseContext,
        requestedText: 'Vklu4i lampite v banqta',
        availableDevices: [...baseContext.availableDevices, 'bath_light'],
      },
    })

    expect(plan.actions).toEqual([
      expect.objectContaining({
        type: 'light.turn_on',
        deviceId: 'bath_light',
        room: 'баня',
      }),
    ])
  })

  it('moves the thermostat one degree warmer for comfort_warmer', () => {
    const plan = planHomeIntent({
      intent: 'comfort_warmer',
      context: {
        ...baseContext,
        targetTempC: 20,
      },
    })

    expect(plan.actions).toEqual([
      expect.objectContaining({
        type: 'thermostat.set_target',
        value: 21,
        risk: 'safe',
      }),
    ])
    expect(plan.spokenReply).toContain('21 градуса')
  })

  it('returns no actions for unknown intent', () => {
    const plan = planHomeIntent({
      intent: 'unknown',
      context: baseContext,
    })

    expect(plan.actions).toEqual([])
    expect(plan.requiresConfirmation).toBe(false)
  })
})

describe('classifyHomeIntent', () => {
  it.each([
    ['Прибирам се след малко.', 'arrival_home'],
    ['ПРИБРАХ СЕ!', 'arrival_home'],
    ["I'm coming home", 'arrival_home'],
    ['Излизам от вкъщи.', 'leaving_home'],
    ['Лека нощ.', 'good_night'],
    ['Включи лампите в кухнята.', 'turn_on_lights'],
    ['Vklu4i lampite v banqta.', 'turn_on_lights'],
    ['Угаси лампите.', 'turn_off_lights'],
    ['Студено ми е.', 'comfort_warmer'],
    ['Направи по-хладно.', 'comfort_cooler'],
    ['Как е вкъщи?', 'status_check'],
    ['Каква е температурата в кухнята?', 'status_check'],
    ['What is the kitchen temperature?', 'status_check'],
  ] as const)('classifies "%s" as %s', (text, expectedIntent) => {
    expect(classifyHomeIntent(text)).toEqual(
      expect.objectContaining({
        intent: expectedIntent,
      }),
    )
  })

  it('keeps open-ended speech as unknown', () => {
    expect(classifyHomeIntent('Разкажи ми нещо интересно.')).toEqual({
      intent: 'unknown',
      confidence: 0,
      matchedPhrase: null,
    })
  })

  it('reports the phrase that triggered the classification', () => {
    expect(classifyHomeIntent('Моля, включи лампите.')).toEqual(
      expect.objectContaining({
        intent: 'turn_on_lights',
        matchedPhrase: 'включи лампите',
      }),
    )
  })
})
