import {
  AutomationPrincipal,
  buildLlmAutomationContext,
  createActionPlan,
  createAuditEvent,
  createAutomationIntent,
  DeviceBinding,
  evaluatePolicy,
  ProposedAutomationAction,
  reconcilePlan,
  validateDeviceBindings,
} from './automation-core'

const scope = { tenantId: 'tenant-a', siteId: 'site-home' }

const principal: AutomationPrincipal = {
  id: 'user-1',
  type: 'human',
  tenantId: 'tenant-a',
  siteIds: ['site-home'],
  permissions: [
    'automation:intent:create',
    'automation:plan:execute',
    'device:light:write',
    'device:switch:write',
    'device:thermostat:write',
    'device:state:read',
  ],
}

const kitchenLight: DeviceBinding = {
  deviceId: 'kitchen-light',
  tenantId: 'tenant-a',
  siteId: 'site-home',
  zoneId: 'kitchen',
  adapterId: 'home-assistant',
  displayName: 'Kitchen light',
  capabilities: [
    {
      kind: 'light',
      actions: ['turn_on', 'turn_off'],
    },
  ],
}

const thermostat: DeviceBinding = {
  deviceId: 'hall-thermostat',
  tenantId: 'tenant-a',
  siteId: 'site-home',
  adapterId: 'home-assistant',
  displayName: 'Hall thermostat',
  capabilities: [
    {
      kind: 'thermostat',
      actions: ['set_target_temperature'],
      minValue: 5,
      maxValue: 30,
      unit: 'C',
    },
  ],
}

function intent() {
  return createAutomationIntent({
    scope,
    principal,
    kind: 'voice_command',
    utterance: 'Включи лампите в кухнята',
    goal: 'turn on kitchen light',
    source: 'voice',
    id: 'intent-1',
    createdAt: '2026-07-31T12:00:00.000Z',
  })
}

function turnOnKitchenLight(): ProposedAutomationAction {
  return {
    type: 'light.turn_on',
    deviceId: 'kitchen-light',
    reason: 'User asked for kitchen lights.',
    predictedStateDelta: { power: true },
  }
}

describe('automation-core policy pipeline', () => {
  it('allows scoped, permitted actions against matching capabilities', () => {
    const decision = evaluatePolicy({
      intent: intent(),
      actions: [turnOnKitchenLight()],
      devices: [kitchenLight],
    })

    expect(decision.allowed).toBe(true)
    expect(decision.reasons).toEqual([])
  })

  it('allows turning lights off through matching capabilities', () => {
    const decision = evaluatePolicy({
      intent: intent(),
      actions: [
        {
          type: 'light.turn_off',
          deviceId: 'kitchen-light',
          reason: 'User asked to turn lights off.',
          predictedStateDelta: { power: false },
        },
      ],
      devices: [kitchenLight],
    })

    expect(decision.allowed).toBe(true)
  })

  it('rejects cross-tenant device actions', () => {
    const otherTenantDevice = {
      ...kitchenLight,
      tenantId: 'tenant-b',
    }

    const decision = evaluatePolicy({
      intent: intent(),
      actions: [turnOnKitchenLight()],
      devices: [otherTenantDevice],
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain('device kitchen-light is outside intent scope')
    expect(decision.deniedActionIndexes).toEqual([0])
  })

  it('rejects principals outside the tenant/site scope', () => {
    const outsiderIntent = createAutomationIntent({
      ...intent(),
      principal: {
        ...principal,
        tenantId: 'tenant-b',
      },
    })

    const decision = evaluatePolicy({
      intent: outsiderIntent,
      actions: [turnOnKitchenLight()],
      devices: [kitchenLight],
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain(
      'principal is not allowed to access this tenant/site scope',
    )
  })

  it('creates intents with generated ids and timestamps when omitted', () => {
    const generated = createAutomationIntent({
      scope,
      principal,
      kind: 'manual_ui',
      goal: 'inspect default fields',
      source: 'ui',
    })

    expect(generated.id).toEqual(expect.any(String))
    expect(generated.createdAt).toEqual(expect.any(String))
  })

  it('rejects duplicate adapter ownership for the same device', () => {
    const result = validateDeviceBindings([
      kitchenLight,
      {
        ...kitchenLight,
        adapterId: 'shelly-direct',
      },
    ])

    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('claimed by multiple adapters')
  })

  it('rejects policy evaluation when devices have duplicate adapter ownership', () => {
    const decision = evaluatePolicy({
      intent: intent(),
      actions: [turnOnKitchenLight()],
      devices: [
        kitchenLight,
        {
          ...kitchenLight,
          adapterId: 'shelly-direct',
        },
      ],
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons[0]).toContain('claimed by multiple adapters')
  })

  it('rejects unsafe thermostat setpoints before execution', () => {
    const decision = evaluatePolicy({
      intent: intent(),
      actions: [
        {
          type: 'thermostat.set_target',
          deviceId: 'hall-thermostat',
          value: 35,
          reason: 'Bad generated action.',
          predictedStateDelta: { targetTemperatureC: 35 },
        },
      ],
      devices: [thermostat],
      guardrails: { thermostatMinC: 8, thermostatMaxC: 28 },
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain(
      'thermostat target 35C is outside physical guardrails',
    )
  })

  it('rejects conflicts with pending plans for the same device', () => {
    const decision = evaluatePolicy({
      intent: intent(),
      actions: [turnOnKitchenLight()],
      devices: [kitchenLight],
      pendingPlans: [
        {
          planId: 'plan-existing',
          scope,
          deviceIds: ['kitchen-light'],
        },
      ],
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain(
      'device kitchen-light already has pending plan plan-existing',
    )
  })

  it('rejects unknown devices', () => {
    const decision = evaluatePolicy({
      intent: intent(),
      actions: [
        {
          ...turnOnKitchenLight(),
          deviceId: 'missing-light',
        },
      ],
      devices: [kitchenLight],
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain('device missing-light is not known')
  })

  it('rejects principals without intent creation permission', () => {
    const limitedIntent = createAutomationIntent({
      ...intent(),
      principal: {
        ...principal,
        permissions: ['device:light:write'],
      },
    })

    const decision = evaluatePolicy({
      intent: limitedIntent,
      actions: [turnOnKitchenLight()],
      devices: [kitchenLight],
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain('principal cannot create automation intents')
  })

  it('rejects principals without device write permission', () => {
    const limitedIntent = createAutomationIntent({
      ...intent(),
      principal: {
        ...principal,
        permissions: ['automation:intent:create'],
      },
    })

    const decision = evaluatePolicy({
      intent: limitedIntent,
      actions: [turnOnKitchenLight()],
      devices: [kitchenLight],
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain(
      'principal lacks permission for light.turn_on',
    )
  })

  it('rejects actions unsupported by the device capability', () => {
    const decision = evaluatePolicy({
      intent: intent(),
      actions: [
        {
          type: 'light.turn_on',
          deviceId: 'hall-thermostat',
          reason: 'LLM picked the wrong device.',
          predictedStateDelta: { power: true },
        },
      ],
      devices: [thermostat],
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain(
      'device hall-thermostat does not expose light',
    )
  })

  it('rejects plans that exceed max action count', () => {
    const decision = evaluatePolicy({
      intent: intent(),
      actions: [turnOnKitchenLight(), turnOnKitchenLight()],
      devices: [kitchenLight],
      guardrails: { maxActionsPerPlan: 1 },
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain('plan exceeds max action count 1')
    expect(decision.deniedActionIndexes).toEqual([0, 1])
  })

  it('ignores pending plans outside the intent scope', () => {
    const decision = evaluatePolicy({
      intent: intent(),
      actions: [turnOnKitchenLight()],
      devices: [kitchenLight],
      pendingPlans: [
        {
          planId: 'other-site-plan',
          scope: { tenantId: 'tenant-a', siteId: 'other-site' },
          deviceIds: ['kitchen-light'],
        },
      ],
    })

    expect(decision.allowed).toBe(true)
  })

  it('ignores same-scope pending plans for different devices', () => {
    const decision = evaluatePolicy({
      intent: intent(),
      actions: [turnOnKitchenLight()],
      devices: [kitchenLight],
      pendingPlans: [
        {
          planId: 'different-device-plan',
          scope,
          deviceIds: ['other-light'],
        },
      ],
    })

    expect(decision.allowed).toBe(true)
  })

  it('creates versioned plans with predicted state and stable idempotency keys', () => {
    const first = createActionPlan({
      intent: intent(),
      actions: [turnOnKitchenLight()],
      createdAt: '2026-07-31T12:00:01.000Z',
    })
    const second = createActionPlan({
      intent: intent(),
      actions: [turnOnKitchenLight()],
      createdAt: '2026-07-31T12:00:02.000Z',
    })

    expect(first.version).toBe(1)
    expect(first.predictedStateDelta).toEqual({
      'kitchen-light': { power: true },
    })
    expect(first.idempotencyKey).toBe(second.idempotencyKey)
  })

  it('detects reconciliation drift when device state does not match the plan', () => {
    const plan = createActionPlan({
      intent: intent(),
      actions: [turnOnKitchenLight()],
    })

    const result = reconcilePlan({
      plan,
      observedState: [
        {
          scope,
          deviceId: 'kitchen-light',
          values: { power: false },
          observedAt: '2026-07-31T12:00:03.000Z',
        },
      ],
    })

    expect(result.driftDetected).toBe(true)
    expect(result.drifts).toEqual([
      {
        deviceId: 'kitchen-light',
        key: 'power',
        expected: true,
        actual: false,
      },
    ])
  })

  it('passes reconciliation when observed state matches the plan', () => {
    const plan = createActionPlan({
      intent: intent(),
      actions: [turnOnKitchenLight()],
    })

    const result = reconcilePlan({
      plan,
      observedState: [
        {
          scope,
          deviceId: 'kitchen-light',
          values: { power: true },
          observedAt: '2026-07-31T12:00:03.000Z',
        },
      ],
    })

    expect(result.driftDetected).toBe(false)
    expect(result.drifts).toEqual([])
  })

  it('builds scoped LLM context with server errors but no execution bypass', () => {
    const context = buildLlmAutomationContext({
      scope,
      principal,
      devices: [
        kitchenLight,
        {
          ...kitchenLight,
          deviceId: 'other-site-light',
          siteId: 'other-site',
        },
      ],
      state: [
        {
          scope,
          deviceId: 'kitchen-light',
          values: { power: false },
          observedAt: '2026-07-31T12:00:00.000Z',
        },
      ],
      recentAuditEvents: [
        createAuditEvent({
          type: 'server.error',
          scope,
          principalId: principal.id,
          payload: { message: 'adapter timeout' },
          occurredAt: '2026-07-31T12:00:04.000Z',
        }),
      ],
      serverErrors: [
        {
          service: 'home-assistant-adapter',
          operation: 'turn_on',
          message: 'timeout',
          occurredAt: '2026-07-31T12:00:04.000Z',
        },
      ],
    })

    expect(context.visibleDevices.map((device) => device.deviceId)).toEqual([
      'kitchen-light',
    ])
    expect(context.serverErrors[0].message).toBe('timeout')
    expect(context.instruction).toContain('Do not execute hardware actions directly')
  })

  it('creates audit events with generated ids and timestamps when omitted', () => {
    const event = createAuditEvent({
      type: 'intent.created',
      scope,
      principalId: principal.id,
      payload: { ok: true },
    })

    expect(event.id).toEqual(expect.any(String))
    expect(event.occurredAt).toEqual(expect.any(String))
  })

  it('rejects malformed unknown action types defensively', () => {
    const decision = evaluatePolicy({
      intent: intent(),
      actions: [
        {
          type: 'unknown.do_anything',
          deviceId: 'kitchen-light',
          reason: 'Bad external payload.',
          predictedStateDelta: {},
        } as ProposedAutomationAction,
      ],
      devices: [kitchenLight],
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain(
      'action unknown.do_anything is not supported',
    )
  })
})

describe('automation-core non-home assets', () => {
  const vehicleScope = {
    tenantId: 'tenant-a',
    siteId: 'site-home',
    assetId: 'vehicle-1',
  }
  const boatScope = {
    tenantId: 'tenant-a',
    siteId: 'marina',
    assetId: 'boat-1',
  }
  const vehiclePrincipal: AutomationPrincipal = {
    ...principal,
    siteIds: ['site-home', 'marina'],
    permissions: [
      'automation:intent:create',
      'device:charger:write',
      'device:pump:write',
      'device:engine:write',
      'device:state:read',
    ],
  }
  const charger: DeviceBinding = {
    deviceId: 'ev-charger',
    tenantId: 'tenant-a',
    siteId: 'site-home',
    assetId: 'vehicle-1',
    adapterId: 'ocpp',
    displayName: 'EV charger',
    capabilities: [
      {
        kind: 'charger',
        actions: ['set_power_limit'],
        unit: 'kW',
      },
    ],
  }
  const bilgePump: DeviceBinding = {
    deviceId: 'bilge-pump',
    tenantId: 'tenant-a',
    siteId: 'marina',
    assetId: 'boat-1',
    adapterId: 'marine-gateway',
    displayName: 'Bilge pump',
    capabilities: [
      {
        kind: 'pump',
        actions: ['start', 'stop'],
      },
    ],
  }
  const engine: DeviceBinding = {
    deviceId: 'boat-engine',
    tenantId: 'tenant-a',
    siteId: 'marina',
    assetId: 'boat-1',
    adapterId: 'marine-gateway',
    displayName: 'Boat engine',
    capabilities: [
      {
        kind: 'engine',
        actions: ['start', 'stop'],
      },
    ],
  }

  function vehicleIntent() {
    return createAutomationIntent({
      scope: vehicleScope,
      principal: vehiclePrincipal,
      kind: 'voice_command',
      goal: 'limit vehicle charging',
      source: 'voice',
      id: 'vehicle-intent-1',
      createdAt: '2026-07-31T12:00:00.000Z',
    })
  }

  function boatIntent() {
    return createAutomationIntent({
      scope: boatScope,
      principal: vehiclePrincipal,
      kind: 'manual_ui',
      goal: 'run bilge pump',
      source: 'ui',
      id: 'boat-intent-1',
      createdAt: '2026-07-31T12:00:00.000Z',
    })
  }

  it('allows vehicle charger actions inside power guardrails', () => {
    const decision = evaluatePolicy({
      intent: vehicleIntent(),
      actions: [
        {
          type: 'charger.set_power_limit',
          deviceId: 'ev-charger',
          value: 7,
          reason: 'Reduce charging load.',
          predictedStateDelta: { powerLimitKw: 7 },
        },
      ],
      devices: [charger],
      guardrails: { chargerMaxPowerKw: 11 },
    })

    expect(decision.allowed).toBe(true)
  })

  it('rejects vehicle charger actions above power guardrails', () => {
    const decision = evaluatePolicy({
      intent: vehicleIntent(),
      actions: [
        {
          type: 'charger.set_power_limit',
          deviceId: 'ev-charger',
          value: 22,
          reason: 'LLM requested too much power.',
          predictedStateDelta: { powerLimitKw: 22 },
        },
      ],
      devices: [charger],
      guardrails: { chargerMaxPowerKw: 11 },
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain(
      'charger power 22kW exceeds guardrail 11kW',
    )
  })

  it('allows boat pump actions through pump capabilities', () => {
    const decision = evaluatePolicy({
      intent: boatIntent(),
      actions: [
        {
          type: 'pump.start',
          deviceId: 'bilge-pump',
          reason: 'Water level alarm.',
          predictedStateDelta: { running: true },
        },
      ],
      devices: [bilgePump],
    })

    expect(decision.allowed).toBe(true)
  })

  it('rejects engine actions even when the device exposes the capability', () => {
    const decision = evaluatePolicy({
      intent: boatIntent(),
      actions: [
        {
          type: 'engine.start',
          deviceId: 'boat-engine',
          reason: 'Unsafe generated action.',
          predictedStateDelta: { running: true },
        },
      ],
      devices: [engine],
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain(
      'engine start requires a dedicated safety workflow',
    )
  })

  it('rejects engine stop with the dedicated safety workflow reason', () => {
    const decision = evaluatePolicy({
      intent: boatIntent(),
      actions: [
        {
          type: 'engine.stop',
          deviceId: 'boat-engine',
          reason: 'Unsafe stop request.',
          predictedStateDelta: { running: false },
        },
      ],
      devices: [engine],
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain(
      'engine stop requires a dedicated safety workflow',
    )
  })

  it('allows non-home switch, lock, and pump stop actions with capabilities', () => {
    const servicePrincipal: AutomationPrincipal = {
      ...vehiclePrincipal,
      permissions: [
        ...vehiclePrincipal.permissions,
        'device:switch:write',
        'device:lock:write',
      ],
    }
    const mixedIntent = createAutomationIntent({
      scope: boatScope,
      principal: servicePrincipal,
      kind: 'manual_ui',
      goal: 'secure boat',
      source: 'ui',
      id: 'mixed-intent-1',
      createdAt: '2026-07-31T12:00:00.000Z',
    })
    const cabinSwitch: DeviceBinding = {
      deviceId: 'cabin-switch',
      tenantId: 'tenant-a',
      siteId: 'marina',
      assetId: 'boat-1',
      adapterId: 'marine-gateway',
      displayName: 'Cabin switch',
      capabilities: [{ kind: 'switch', actions: ['turn_on', 'turn_off'] }],
    }
    const hatchLock: DeviceBinding = {
      deviceId: 'hatch-lock',
      tenantId: 'tenant-a',
      siteId: 'marina',
      assetId: 'boat-1',
      adapterId: 'marine-gateway',
      displayName: 'Hatch lock',
      capabilities: [{ kind: 'lock', actions: ['lock', 'unlock'] }],
    }

    const decision = evaluatePolicy({
      intent: mixedIntent,
      actions: [
        {
          type: 'switch.turn_on',
          deviceId: 'cabin-switch',
          reason: 'Power cabin circuit.',
          predictedStateDelta: { power: true },
        },
        {
          type: 'switch.turn_off',
          deviceId: 'cabin-switch',
          reason: 'Power down cabin circuit.',
          predictedStateDelta: { power: false },
        },
        {
          type: 'lock.lock',
          deviceId: 'hatch-lock',
          reason: 'Secure hatch.',
          predictedStateDelta: { locked: true },
        },
        {
          type: 'lock.unlock',
          deviceId: 'hatch-lock',
          reason: 'Open hatch.',
          predictedStateDelta: { locked: false },
        },
        {
          type: 'pump.stop',
          deviceId: 'bilge-pump',
          reason: 'Stop pump after water clears.',
          predictedStateDelta: { running: false },
        },
      ],
      devices: [cabinSwitch, hatchLock, bilgePump],
    })

    expect(decision.allowed).toBe(true)
  })

  it('rejects capability actions the device does not support', () => {
    const readOnlySwitch: DeviceBinding = {
      deviceId: 'readonly-switch',
      tenantId: 'tenant-a',
      siteId: 'marina',
      assetId: 'boat-1',
      adapterId: 'marine-gateway',
      displayName: 'Read only switch',
      capabilities: [{ kind: 'switch', actions: ['read'] }],
    }

    const decision = evaluatePolicy({
      intent: {
        ...boatIntent(),
        principal: {
          ...vehiclePrincipal,
          permissions: [
            ...vehiclePrincipal.permissions,
            'device:switch:write',
          ],
        },
      },
      actions: [
        {
          type: 'switch.turn_on',
          deviceId: 'readonly-switch',
          reason: 'Unsupported switch write.',
          predictedStateDelta: { power: true },
        },
      ],
      devices: [readOnlySwitch],
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain('device readonly-switch cannot turn_on')
  })

  it('keeps LLM context scoped to the selected asset', () => {
    const context = buildLlmAutomationContext({
      scope: vehicleScope,
      principal: vehiclePrincipal,
      devices: [charger, bilgePump],
      state: [
        {
          scope: vehicleScope,
          deviceId: 'ev-charger',
          values: { powerLimitKw: 7 },
          observedAt: '2026-07-31T12:00:00.000Z',
        },
        {
          scope: boatScope,
          deviceId: 'bilge-pump',
          values: { running: false },
          observedAt: '2026-07-31T12:00:00.000Z',
        },
      ],
    })

    expect(context.visibleDevices.map((device) => device.deviceId)).toEqual([
      'ev-charger',
    ])
    expect(context.state.map((snapshot) => snapshot.deviceId)).toEqual([
      'ev-charger',
    ])
  })
})
