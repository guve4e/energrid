export type HomeIntent =
  | 'arrival_home'
  | 'leaving_home'
  | 'good_night'
  | 'wake_up'
  | 'turn_on_lights'
  | 'turn_off_lights'
  | 'comfort_warmer'
  | 'comfort_cooler'
  | 'status_check'
  | 'unknown'

export type HomeMode = 'home' | 'away' | 'night'

export type HomeActionRisk = 'safe' | 'confirmation_required'

export interface HomeContext {
  outsideDark: boolean
  insideTempC: number | null
  targetTempC: number | null
  comfortTempC: number
  homeMode: HomeMode
  availableDevices: string[]
  occupiedRooms: string[]
  alarmArmed: boolean
  requestedText?: string
}

export interface PlannedHomeAction {
  type:
    | 'light.turn_on'
    | 'light.turn_off'
    | 'thermostat.set_target'
    | 'mode.set'
    | 'alarm.disarm'
    | 'status.report'
  deviceId?: string
  room?: string
  value?: string | number
  risk: HomeActionRisk
  reason: string
}

export interface HomeIntentPlan {
  intent: HomeIntent
  actions: PlannedHomeAction[]
  spokenReply: string
  requiresConfirmation: boolean
}

export interface PlanHomeIntentInput {
  intent: HomeIntent
  context: HomeContext
}

export interface ClassifyHomeIntentResult {
  intent: HomeIntent
  confidence: number
  matchedPhrase: string | null
}

const intentPatterns: Array<{
  intent: HomeIntent
  confidence: number
  phrases: string[]
}> = [
  {
    intent: 'arrival_home',
    confidence: 0.92,
    phrases: [
      'прибирам се',
      'прибрах се',
      'идвам си',
      'отивам към вкъщи',
      'след малко съм вкъщи',
      'coming home',
      'i am coming home',
      "i'm coming home",
    ],
  },
  {
    intent: 'leaving_home',
    confidence: 0.9,
    phrases: [
      'излизам',
      'тръгвам',
      'няма да съм вкъщи',
      'излизам от вкъщи',
      'leaving home',
      'i am leaving',
      "i'm leaving",
    ],
  },
  {
    intent: 'good_night',
    confidence: 0.94,
    phrases: ['лека нощ', 'отивам да спя', 'ще спя', 'good night'],
  },
  {
    intent: 'turn_on_lights',
    confidence: 0.9,
    phrases: [
      'включи лампите',
      'включи лампата',
      'пусни лампите',
      'пусни лампата',
      'светни лампите',
      'светни лампата',
      'включи осветлението',
      'vkluchi lampite',
      'vklu4i lampite',
      'pusni lampite',
      'turn on the lights',
      'lights on',
    ],
  },
  {
    intent: 'turn_off_lights',
    confidence: 0.9,
    phrases: [
      'изключи лампите',
      'изключи лампата',
      'спри лампите',
      'спри лампата',
      'угаси лампите',
      'угаси лампата',
      'изключи осветлението',
      'izkluchi lampite',
      'izklu4i lampite',
      'ugasi lampite',
      'turn off the lights',
      'lights off',
    ],
  },
  {
    intent: 'comfort_warmer',
    confidence: 0.86,
    phrases: [
      'студено ми е',
      'направи по-топло',
      'по-топло',
      'вдигни температурата',
      'too cold',
      'make it warmer',
    ],
  },
  {
    intent: 'comfort_cooler',
    confidence: 0.86,
    phrases: [
      'топло ми е',
      'направи по-хладно',
      'по-хладно',
      'намали температурата',
      'too hot',
      'make it cooler',
    ],
  },
  {
    intent: 'status_check',
    confidence: 0.82,
    phrases: [
      'какво е състоянието',
      'как е вкъщи',
      'статус на къщата',
      'каква е температурата',
      'каква е температурата в кухнята',
      'колко градуса е',
      'колко градуса е в кухнята',
      'temperature in the kitchen',
      'kitchen temperature',
      'home status',
      'house status',
    ],
  },
]

export function classifyHomeIntent(text: string): ClassifyHomeIntentResult {
  const normalized = normalizeIntentText(text)

  if (!normalized) {
    return unknownClassification()
  }

  for (const pattern of intentPatterns) {
    const matchedPhrase = pattern.phrases.find((phrase) =>
      normalized.includes(normalizeIntentText(phrase)),
    )

    if (matchedPhrase) {
      return {
        intent: pattern.intent,
        confidence: pattern.confidence,
        matchedPhrase,
      }
    }
  }

  return unknownClassification()
}

export function planHomeIntent(input: PlanHomeIntentInput): HomeIntentPlan {
  switch (input.intent) {
    case 'arrival_home':
      return planArrivalHome(input.context)

    case 'leaving_home':
      return planLeavingHome(input.context)

    case 'good_night':
      return planGoodNight(input.context)

    case 'turn_on_lights':
      return planTurnOnLights(input.context)

    case 'turn_off_lights':
      return planTurnOffLights(input.context)

    case 'comfort_warmer':
      return planWarmer(input.context)

    case 'status_check':
      return planStatus(input.context)

    default:
      return {
        intent: input.intent,
        actions: [],
        spokenReply: 'Разбрах, но още нямам правило за това.',
        requiresConfirmation: false,
      }
  }
}

function normalizeIntentText(text: string): string {
  return text
    .toLocaleLowerCase('bg')
    .normalize('NFKC')
    .replace(/[.,!?;:()\[\]"'`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function unknownClassification(): ClassifyHomeIntentResult {
  return {
    intent: 'unknown',
    confidence: 0,
    matchedPhrase: null,
  }
}

function planArrivalHome(context: HomeContext): HomeIntentPlan {
  const actions: PlannedHomeAction[] = [
    {
      type: 'mode.set',
      value: 'home',
      risk: 'safe',
      reason: 'User said they are coming home.',
    },
  ]

  if (context.outsideDark) {
    addLightIfAvailable(actions, context, 'entry_light', 'вход')
    addLightIfAvailable(actions, context, 'hallway_light', 'коридор')
    addLightIfAvailable(actions, context, 'kitchen_light', 'кухня')
  }

  if (shouldRaiseTemperature(context)) {
    actions.push({
      type: 'thermostat.set_target',
      deviceId: 'thermostat',
      value: context.comfortTempC,
      risk: 'safe',
      reason: 'Home is below comfort temperature on arrival.',
    })
  }

  if (context.alarmArmed) {
    actions.push({
      type: 'alarm.disarm',
      risk: 'confirmation_required',
      reason: 'Disarming alarm is sensitive and needs confirmation.',
    })
  }

  return {
    intent: 'arrival_home',
    actions,
    requiresConfirmation: actions.some((action) => action.risk === 'confirmation_required'),
    spokenReply: buildArrivalReply(actions, context),
  }
}

function planLeavingHome(context: HomeContext): HomeIntentPlan {
  const actions: PlannedHomeAction[] = [
    {
      type: 'mode.set',
      value: 'away',
      risk: 'safe',
      reason: 'User said they are leaving.',
    },
  ]

  for (const deviceId of ['entry_light', 'hallway_light', 'kitchen_light']) {
    if (context.availableDevices.includes(deviceId)) {
      actions.push({
        type: 'light.turn_off',
        deviceId,
        risk: 'safe',
        reason: 'Leaving home should turn off non-essential lights.',
      })
    }
  }

  return {
    intent: 'leaving_home',
    actions,
    requiresConfirmation: false,
    spokenReply: 'Добре, превключвам къщата в режим извън дома и гася ненужните светлини.',
  }
}

function planGoodNight(context: HomeContext): HomeIntentPlan {
  const actions: PlannedHomeAction[] = [
    {
      type: 'mode.set',
      value: 'night',
      risk: 'safe',
      reason: 'User said good night.',
    },
  ]

  for (const deviceId of ['kitchen_light', 'hallway_light']) {
    if (context.availableDevices.includes(deviceId)) {
      actions.push({
        type: 'light.turn_off',
        deviceId,
        risk: 'safe',
        reason: 'Night mode turns off common-area lights.',
      })
    }
  }

  return {
    intent: 'good_night',
    actions,
    requiresConfirmation: false,
    spokenReply: 'Лека нощ. Превключвам в нощен режим и гася общите светлини.',
  }
}

function planTurnOnLights(context: HomeContext): HomeIntentPlan {
  const actions: PlannedHomeAction[] = []
  const target = chooseRequestedLight(context)

  if (target) {
    addLightIfAvailable(actions, context, target.deviceId, target.room)
  } else {
    addLightIfAvailable(actions, context, 'kitchen_light', 'кухня')
  }

  return {
    intent: 'turn_on_lights',
    actions,
    requiresConfirmation: false,
    spokenReply:
      actions.length > 0
        ? 'Включвам лампите.'
        : 'Не виждам налични лампи за включване.',
  }
}

function planTurnOffLights(context: HomeContext): HomeIntentPlan {
  const target = chooseRequestedLight(context)
  const targetDeviceIds = target
    ? [target.deviceId]
    : context.availableDevices.filter((deviceId) => deviceId.endsWith('_light'))

  const actions = targetDeviceIds.map<PlannedHomeAction>((deviceId) => ({
      type: 'light.turn_off',
      deviceId,
      room: target?.deviceId === deviceId ? target.room : undefined,
      risk: 'safe',
      reason: 'User requested lights off.',
    }))

  return {
    intent: 'turn_off_lights',
    actions,
    requiresConfirmation: false,
    spokenReply: actions.length > 0 ? 'Гася лампите.' : 'Не виждам налични лампи за гасене.',
  }
}

function planWarmer(context: HomeContext): HomeIntentPlan {
  const currentTarget = context.targetTempC ?? context.comfortTempC
  const nextTarget = Math.min(currentTarget + 1, context.comfortTempC + 2)

  return {
    intent: 'comfort_warmer',
    actions: [
      {
        type: 'thermostat.set_target',
        deviceId: 'thermostat',
        value: nextTarget,
        risk: 'safe',
        reason: 'User requested warmer comfort.',
      },
    ],
    requiresConfirmation: false,
    spokenReply: `Добре, вдигам температурата до ${nextTarget} градуса.`,
  }
}

function planStatus(context: HomeContext): HomeIntentPlan {
  return {
    intent: 'status_check',
    actions: [
      {
        type: 'status.report',
        risk: 'safe',
        reason: 'User requested home status.',
      },
    ],
    requiresConfirmation: false,
    spokenReply: `Режимът е ${context.homeMode}, вътре е ${context.insideTempC ?? 'неизвестно'} градуса.`,
  }
}

function addLightIfAvailable(
  actions: PlannedHomeAction[],
  context: HomeContext,
  deviceId: string,
  room: string,
): void {
  if (!context.availableDevices.includes(deviceId)) return

  actions.push({
    type: 'light.turn_on',
    deviceId,
    room,
    risk: 'safe',
    reason: 'Lighting is safe and useful for this intent.',
  })
}

function chooseRequestedLight(
  context: HomeContext,
): { deviceId: string; room: string } | null {
  const room = requestedRoomFromText(context.requestedText || '')
  if (!room) return null

  for (const candidate of lightCandidatesForRoom(room.key)) {
    if (context.availableDevices.includes(candidate)) {
      return { deviceId: candidate, room: room.bg }
    }
  }

  const matchingDevice = context.availableDevices.find(
    (deviceId) =>
      deviceId.includes(room.key) &&
      (deviceId.includes('light') || deviceId.includes('lamp')),
  )

  return matchingDevice ? { deviceId: matchingDevice, room: room.bg } : null
}

function requestedRoomFromText(
  text: string,
): { key: string; bg: string } | null {
  const normalized = normalizeIntentText(text)
  if (!normalized) return null

  if (
    matchesAny(normalized, [
      'баня',
      'банята',
      'bathroom',
      'bath',
      'banq',
      'banqta',
      'bania',
      'banyata',
    ])
  ) {
    return { key: 'bath', bg: 'баня' }
  }

  if (
    matchesAny(normalized, [
      'кухня',
      'кухнята',
      'kitchen',
      'kuhnq',
      'kuhnqta',
      'kuhnia',
      'kuhnyata',
    ])
  ) {
    return { key: 'kitchen', bg: 'кухня' }
  }

  if (
    matchesAny(normalized, [
      'коридор',
      'коридора',
      'антре',
      'hall',
      'hallway',
      'koridor',
      'antre',
    ])
  ) {
    return { key: 'hallway', bg: 'коридор' }
  }

  if (matchesAny(normalized, ['вход', 'входа', 'entry', 'entrance', 'vhod'])) {
    return { key: 'entry', bg: 'вход' }
  }

  return null
}

function matchesAny(text: string, phrases: string[]): boolean {
  return phrases.some((phrase) => text.includes(normalizeIntentText(phrase)))
}

function lightCandidatesForRoom(room: string): string[] {
  switch (room) {
    case 'bath':
      return [
        'bath_light',
        'bathroom_light',
        'bath.lights',
        'bath.light',
        'bath_light_led',
        'bath.light.led',
      ]
    case 'kitchen':
      return [
        'kitchen_light',
        'kitchen.lights',
        'kitchen.light',
        'kitchen_light_led',
        'kitchen.light.led',
      ]
    case 'hallway':
      return ['hallway_light', 'hall_light', 'hallway.lights', 'hall.lights']
    case 'entry':
      return ['entry_light', 'entrance_light', 'entry.lights', 'entrance.lights']
    default:
      return [`${room}_light`, `${room}.lights`]
  }
}

function shouldRaiseTemperature(context: HomeContext): boolean {
  if (!context.availableDevices.includes('thermostat')) return false
  if (context.insideTempC == null) return false
  return context.insideTempC < context.comfortTempC - 0.5
}

function buildArrivalReply(
  actions: PlannedHomeAction[],
  context: HomeContext,
): string {
  const parts = ['Добре, подготвям къщата.']

  if (context.outsideDark && actions.some((action) => action.type === 'light.turn_on')) {
    parts.push('Навън е тъмно, включвам подходящите светлини.')
  }

  const thermostatAction = actions.find(
    (action) => action.type === 'thermostat.set_target',
  )
  if (thermostatAction) {
    parts.push(`Вдигам температурата до ${thermostatAction.value} градуса.`)
  }

  if (actions.some((action) => action.type === 'alarm.disarm')) {
    parts.push('За алармата ще ми трябва потвърждение.')
  }

  return parts.join(' ')
}
