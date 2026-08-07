import { createHash, randomUUID } from 'crypto'

export type TenantId = string
export type SiteId = string
export type ZoneId = string
export type DeviceId = string
export type AdapterId = string
export type PrincipalId = string
export type AssetId = string

export interface AutomationScope {
  tenantId: TenantId
  siteId: SiteId
  assetId?: AssetId
}

export type PrincipalType = 'human' | 'llm' | 'schedule' | 'rule' | 'service'

export interface AutomationPrincipal {
  id: PrincipalId
  type: PrincipalType
  tenantId: TenantId
  siteIds: SiteId[]
  permissions: AutomationPermission[]
}

export type AutomationPermission =
  | 'automation:intent:create'
  | 'automation:plan:execute'
  | 'device:light:write'
  | 'device:thermostat:write'
  | 'device:switch:write'
  | 'device:lock:write'
  | 'device:pump:write'
  | 'device:charger:write'
  | 'device:engine:write'
  | 'device:state:read'
  | 'audit:read'

export type AssetKind =
  | 'home'
  | 'building'
  | 'vehicle'
  | 'boat'
  | 'battery_site'
  | 'industrial_site'
  | 'other'

export interface ManagedAsset {
  assetId: AssetId
  tenantId: TenantId
  siteId: SiteId
  kind: AssetKind
  displayName: string
}

export type CapabilityKind =
  | 'light'
  | 'thermostat'
  | 'switch'
  | 'sensor'
  | 'lock'
  | 'pump'
  | 'charger'
  | 'engine'

export interface DeviceCapability {
  kind: CapabilityKind
  actions: CapabilityAction[]
  minValue?: number
  maxValue?: number
  unit?: string
}

export type CapabilityAction =
  | 'turn_on'
  | 'turn_off'
  | 'set_target_temperature'
  | 'lock'
  | 'unlock'
  | 'set_power_limit'
  | 'start'
  | 'stop'
  | 'read'

export interface DeviceBinding {
  deviceId: DeviceId
  tenantId: TenantId
  siteId: SiteId
  assetId?: AssetId
  zoneId?: ZoneId
  adapterId: AdapterId
  displayName: string
  capabilities: DeviceCapability[]
}

export type AutomationIntentKind =
  | 'voice_command'
  | 'scheduled_rule'
  | 'external_signal'
  | 'manual_ui'

export interface AutomationIntent {
  id: string
  scope: AutomationScope
  principal: AutomationPrincipal
  kind: AutomationIntentKind
  utterance?: string
  goal: string
  createdAt: string
  source: 'voice' | 'ui' | 'api' | 'system'
}

export type AutomationActionType =
  | 'light.turn_on'
  | 'light.turn_off'
  | 'thermostat.set_target'
  | 'switch.turn_on'
  | 'switch.turn_off'
  | 'lock.lock'
  | 'lock.unlock'
  | 'pump.start'
  | 'pump.stop'
  | 'charger.set_power_limit'
  | 'engine.start'
  | 'engine.stop'

export interface ProposedAutomationAction {
  type: AutomationActionType
  deviceId: DeviceId
  value?: number | string | boolean
  reason: string
  predictedStateDelta: Record<string, unknown>
}

export interface AutomationActionPlan {
  id: string
  version: 1
  scope: AutomationScope
  intentId: string
  principalId: PrincipalId
  actions: ReadonlyArray<ProposedAutomationAction>
  predictedStateDelta: Readonly<Record<DeviceId, Record<string, unknown>>>
  idempotencyKey: string
  createdAt: string
  status: 'proposed' | 'approved' | 'rejected'
}

export interface PolicyDecision {
  allowed: boolean
  reasons: string[]
  deniedActionIndexes: number[]
}

export interface PolicyGuardrails {
  thermostatMinC: number
  thermostatMaxC: number
  chargerMaxPowerKw: number
  maxActionsPerPlan: number
  disallowEngineStart: boolean
}

export interface PendingPlanSummary {
  planId: string
  scope: AutomationScope
  deviceIds: DeviceId[]
}

export type ExecutionStatus = 'success' | 'failed' | 'timeout' | 'skipped'

export interface ExecutionResult {
  planId: string
  actionIndex: number
  deviceId: DeviceId
  status: ExecutionStatus
  reason?: string
  adapterId?: AdapterId
}

export interface DeviceStateSnapshot {
  scope: AutomationScope
  deviceId: DeviceId
  values: Record<string, unknown>
  observedAt: string
}

export interface ReconciliationResult {
  planId: string
  driftDetected: boolean
  drifts: Array<{
    deviceId: DeviceId
    key: string
    expected: unknown
    actual: unknown
  }>
}

export type AutomationAuditEventType =
  | 'intent.created'
  | 'policy.evaluated'
  | 'plan.created'
  | 'execution.completed'
  | 'state.reconciled'
  | 'server.error'

export interface AutomationAuditEvent {
  id: string
  type: AutomationAuditEventType
  scope: AutomationScope
  principalId?: PrincipalId
  occurredAt: string
  payload: Record<string, unknown>
}

export interface ServerErrorContext {
  service: string
  operation: string
  message: string
  code?: string
  occurredAt: string
}

export interface LlmAutomationContext {
  scope: AutomationScope
  principal: AutomationPrincipal
  visibleDevices: DeviceBinding[]
  state: DeviceStateSnapshot[]
  recentAuditEvents: AutomationAuditEvent[]
  serverErrors: ServerErrorContext[]
  activePlan?: AutomationActionPlan
  policyDecision?: PolicyDecision
  instruction: string
}

const defaultGuardrails: PolicyGuardrails = {
  thermostatMinC: 5,
  thermostatMaxC: 30,
  chargerMaxPowerKw: 11,
  maxActionsPerPlan: 20,
  disallowEngineStart: true,
}

export function createAutomationIntent(
  input: Omit<AutomationIntent, 'id' | 'createdAt'> & {
    id?: string
    createdAt?: string
  },
): AutomationIntent {
  return {
    ...input,
    id: input.id || randomUUID(),
    createdAt: input.createdAt || new Date().toISOString(),
  }
}

export function createActionPlan(input: {
  intent: AutomationIntent
  actions: ProposedAutomationAction[]
  createdAt?: string
}): AutomationActionPlan {
  const predictedStateDelta = input.actions.reduce<
    Record<DeviceId, Record<string, unknown>>
  >((acc, action) => {
    acc[action.deviceId] = {
      ...(acc[action.deviceId] || {}),
      ...action.predictedStateDelta,
    }
    return acc
  }, {})

  const createdAt = input.createdAt || new Date().toISOString()

  const plan: AutomationActionPlan = {
    id: randomUUID(),
    version: 1,
    scope: input.intent.scope,
    intentId: input.intent.id,
    principalId: input.intent.principal.id,
    actions: input.actions,
    predictedStateDelta,
    idempotencyKey: createIdempotencyKey({
      scope: input.intent.scope,
      intentId: input.intent.id,
      principalId: input.intent.principal.id,
      actions: input.actions,
    }),
    createdAt,
    status: 'proposed',
  }

  return Object.freeze({
    ...plan,
    actions: Object.freeze([...plan.actions]),
    predictedStateDelta: Object.freeze({ ...plan.predictedStateDelta }),
  })
}

export function evaluatePolicy(input: {
  intent: AutomationIntent
  actions: ProposedAutomationAction[]
  devices: DeviceBinding[]
  pendingPlans?: PendingPlanSummary[]
  guardrails?: Partial<PolicyGuardrails>
}): PolicyDecision {
  const guardrails = { ...defaultGuardrails, ...input.guardrails }
  const reasons: string[] = []
  const deniedActionIndexes = new Set<number>()

  if (!principalCanAccessScope(input.intent.principal, input.intent.scope)) {
    reasons.push('principal is not allowed to access this tenant/site scope')
    input.actions.forEach((_, index) => deniedActionIndexes.add(index))
  }

  if (!input.intent.principal.permissions.includes('automation:intent:create')) {
    reasons.push('principal cannot create automation intents')
    input.actions.forEach((_, index) => deniedActionIndexes.add(index))
  }

  if (input.actions.length > guardrails.maxActionsPerPlan) {
    reasons.push(`plan exceeds max action count ${guardrails.maxActionsPerPlan}`)
    input.actions.forEach((_, index) => deniedActionIndexes.add(index))
  }

  const ownership = validateDeviceBindings(input.devices)
  if (!ownership.valid) {
    reasons.push(...ownership.errors)
    input.actions.forEach((_, index) => deniedActionIndexes.add(index))
  }

  input.actions.forEach((action, index) => {
    const device = input.devices.find(
      (candidate) => candidate.deviceId === action.deviceId,
    )

    if (!device) {
      reasons.push(`device ${action.deviceId} is not known`)
      deniedActionIndexes.add(index)
      return
    }

    if (!sameScope(device, input.intent.scope)) {
      reasons.push(`device ${action.deviceId} is outside intent scope`)
      deniedActionIndexes.add(index)
    }

    if (!principalCanWriteAction(input.intent.principal, action.type)) {
      reasons.push(`principal lacks permission for ${action.type}`)
      deniedActionIndexes.add(index)
    }

    const capabilityResult = validateActionCapability(action, device)
    if (!capabilityResult.valid) {
      reasons.push(capabilityResult.reason)
      deniedActionIndexes.add(index)
    }

    if (
      action.type === 'thermostat.set_target' &&
      typeof action.value === 'number' &&
      (action.value < guardrails.thermostatMinC ||
        action.value > guardrails.thermostatMaxC)
    ) {
      reasons.push(
        `thermostat target ${action.value}C is outside physical guardrails`,
      )
      deniedActionIndexes.add(index)
    }

    if (
      action.type === 'charger.set_power_limit' &&
      typeof action.value === 'number' &&
      action.value > guardrails.chargerMaxPowerKw
    ) {
      reasons.push(
        `charger power ${action.value}kW exceeds guardrail ${guardrails.chargerMaxPowerKw}kW`,
      )
      deniedActionIndexes.add(index)
    }

    if (action.type === 'engine.start' && guardrails.disallowEngineStart) {
      reasons.push('engine start requires a dedicated safety workflow')
      deniedActionIndexes.add(index)
    }

    if (action.type === 'engine.stop') {
      reasons.push('engine stop requires a dedicated safety workflow')
      deniedActionIndexes.add(index)
    }
  })

  for (const pendingPlan of input.pendingPlans || []) {
    if (!sameScope(pendingPlan.scope, input.intent.scope)) continue

    input.actions.forEach((action, index) => {
      if (pendingPlan.deviceIds.includes(action.deviceId)) {
        reasons.push(
          `device ${action.deviceId} already has pending plan ${pendingPlan.planId}`,
        )
        deniedActionIndexes.add(index)
      }
    })
  }

  return {
    allowed: deniedActionIndexes.size === 0,
    reasons,
    deniedActionIndexes: [...deniedActionIndexes].sort((a, b) => a - b),
  }
}

export function validateDeviceBindings(devices: DeviceBinding[]): {
  valid: boolean
  errors: string[]
} {
  const seen = new Map<DeviceId, AdapterId>()
  const errors: string[] = []

  for (const device of devices) {
    const adapterId = seen.get(device.deviceId)
    if (adapterId && adapterId !== device.adapterId) {
      errors.push(
        `device ${device.deviceId} is claimed by multiple adapters: ${adapterId}, ${device.adapterId}`,
      )
    }
    seen.set(device.deviceId, device.adapterId)
  }

  return { valid: errors.length === 0, errors }
}

export function reconcilePlan(input: {
  plan: AutomationActionPlan
  observedState: DeviceStateSnapshot[]
}): ReconciliationResult {
  const drifts: ReconciliationResult['drifts'] = []

  for (const [deviceId, expectedDelta] of Object.entries(
    input.plan.predictedStateDelta,
  )) {
    const observed = input.observedState.find(
      (snapshot) =>
        snapshot.deviceId === deviceId &&
        sameScope(snapshot.scope, input.plan.scope),
    )

    for (const [key, expected] of Object.entries(expectedDelta)) {
      const actual = observed?.values[key]
      if (actual !== expected) {
        drifts.push({ deviceId, key, expected, actual })
      }
    }
  }

  return {
    planId: input.plan.id,
    driftDetected: drifts.length > 0,
    drifts,
  }
}

export function createAuditEvent(
  event: Omit<AutomationAuditEvent, 'id' | 'occurredAt'> & {
    id?: string
    occurredAt?: string
  },
): AutomationAuditEvent {
  return {
    ...event,
    id: event.id || randomUUID(),
    occurredAt: event.occurredAt || new Date().toISOString(),
  }
}

export function buildLlmAutomationContext(input: {
  scope: AutomationScope
  principal: AutomationPrincipal
  devices: DeviceBinding[]
  state: DeviceStateSnapshot[]
  recentAuditEvents?: AutomationAuditEvent[]
  serverErrors?: ServerErrorContext[]
  activePlan?: AutomationActionPlan
  policyDecision?: PolicyDecision
}): LlmAutomationContext {
  const visibleDevices = input.devices.filter((device) =>
    sameScope(device, input.scope),
  )
  const visibleState = input.state.filter((snapshot) =>
    sameScope(snapshot.scope, input.scope),
  )
  const visibleEvents = (input.recentAuditEvents || []).filter((event) =>
    sameScope(event.scope, input.scope),
  )

  return {
    scope: input.scope,
    principal: input.principal,
    visibleDevices,
    state: visibleState,
    recentAuditEvents: visibleEvents,
    serverErrors: input.serverErrors || [],
    activePlan: input.activePlan,
    policyDecision: input.policyDecision,
    instruction:
      'Use this context to explain, diagnose, or propose automation intents. Do not execute hardware actions directly; every proposed action must pass policy evaluation and audited execution.',
  }
}

function createIdempotencyKey(input: {
  scope: AutomationScope
  intentId: string
  principalId: PrincipalId
  actions: ProposedAutomationAction[]
}): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
}

function principalCanAccessScope(
  principal: AutomationPrincipal,
  scope: AutomationScope,
): boolean {
  return (
    principal.tenantId === scope.tenantId && principal.siteIds.includes(scope.siteId)
  )
}

function sameScope(
  left: AutomationScope,
  right: AutomationScope,
): boolean {
  if (left.tenantId !== right.tenantId || left.siteId !== right.siteId) {
    return false
  }

  if (right.assetId != null) {
    return left.assetId === right.assetId
  }

  return true
}

function principalCanWriteAction(
  principal: AutomationPrincipal,
  type: AutomationActionType,
): boolean {
  if (type.startsWith('light.')) {
    return principal.permissions.includes('device:light:write')
  }

  if (type.startsWith('switch.')) {
    return principal.permissions.includes('device:switch:write')
  }

  if (type.startsWith('thermostat.')) {
    return principal.permissions.includes('device:thermostat:write')
  }

  if (type.startsWith('lock.')) {
    return principal.permissions.includes('device:lock:write')
  }

  if (type.startsWith('pump.')) {
    return principal.permissions.includes('device:pump:write')
  }

  if (type.startsWith('charger.')) {
    return principal.permissions.includes('device:charger:write')
  }

  if (type.startsWith('engine.')) {
    return principal.permissions.includes('device:engine:write')
  }

  return false
}

function validateActionCapability(
  action: ProposedAutomationAction,
  device: DeviceBinding,
): { valid: boolean; reason: string } {
  const required = requiredCapability(action.type)
  if (!required) {
    return {
      valid: false,
      reason: `action ${action.type} is not supported`,
    }
  }

  const capability = device.capabilities.find(
    (candidate) => candidate.kind === required.kind,
  )

  if (!capability) {
    return {
      valid: false,
      reason: `device ${device.deviceId} does not expose ${required.kind}`,
    }
  }

  if (!capability.actions.includes(required.action)) {
    return {
      valid: false,
      reason: `device ${device.deviceId} cannot ${required.action}`,
    }
  }

  return { valid: true, reason: '' }
}

function requiredCapability(type: AutomationActionType): {
  kind: CapabilityKind
  action: CapabilityAction
} | null {
  switch (type) {
    case 'light.turn_on':
      return { kind: 'light', action: 'turn_on' }
    case 'light.turn_off':
      return { kind: 'light', action: 'turn_off' }
    case 'switch.turn_on':
      return { kind: 'switch', action: 'turn_on' }
    case 'switch.turn_off':
      return { kind: 'switch', action: 'turn_off' }
    case 'thermostat.set_target':
      return { kind: 'thermostat', action: 'set_target_temperature' }
    case 'lock.lock':
      return { kind: 'lock', action: 'lock' }
    case 'lock.unlock':
      return { kind: 'lock', action: 'unlock' }
    case 'pump.start':
      return { kind: 'pump', action: 'start' }
    case 'pump.stop':
      return { kind: 'pump', action: 'stop' }
    case 'charger.set_power_limit':
      return { kind: 'charger', action: 'set_power_limit' }
    case 'engine.start':
      return { kind: 'engine', action: 'start' }
    case 'engine.stop':
      return { kind: 'engine', action: 'stop' }
    default:
      return null
  }
}
