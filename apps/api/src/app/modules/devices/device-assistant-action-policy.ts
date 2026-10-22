export interface AssistantActionScope {
  tenantId: string;
  siteId: string;
}

export interface AssistantActionDevice {
  id: string;
  tenantId: string;
  siteId: string;
  kind: string;
  trustStatus: string;
  assistantEnabled?: boolean;
  metadata?: Record<string, string | number | boolean>;
  capabilities: readonly { kind: string }[];
  control?: {
    binding?: {
      enabled: boolean;
    } | null;
  };
}

export type AssistantActionDecision =
  | { allowed: true; confirmation: 'none' }
  | { allowed: false; reason: string };

export function authorizeInstantLightingAction(
  scope: AssistantActionScope,
  device: AssistantActionDevice,
  action: string,
  enrolled: boolean,
  allowlistedIds: ReadonlySet<string>,
): AssistantActionDecision {
  if (action !== 'turn_on' && action !== 'turn_off')
    return { allowed: false, reason: 'unsupported_action' };

  if (
    !scope.tenantId ||
    !scope.siteId ||
    device.tenantId !== scope.tenantId ||
    device.siteId !== scope.siteId
  ) return { allowed: false, reason: 'scope_mismatch' };

  if (device.kind !== 'physical' ||
      device.trustStatus !== 'approved')
    return { allowed: false, reason: 'device_not_approved' };

  if (!enrolled)
    return { allowed: false, reason: 'device_not_enrolled' };

  if (!device.assistantEnabled)
    return { allowed: false, reason: 'assistant_disabled' };

  if (device.metadata?.loadType !== 'lighting')
    return { allowed: false, reason: 'not_approved_lighting' };

  if (!device.capabilities.some(capability =>
    capability.kind === 'light' ||
    capability.kind === 'switch'
  )) return { allowed: false, reason: 'capability_missing' };

  if (!device.control?.binding?.enabled)
    return { allowed: false, reason: 'control_route_disabled' };

  // Explicit per-installation opt-in for this first sprint.
  if (!allowlistedIds.has(device.id))
    return { allowed: false, reason: 'instant_control_not_enabled' };

  return { allowed: true, confirmation: 'none' };
}
