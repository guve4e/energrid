import {
  routeLightingIntent,
  type LightingRoomAlias,
} from './lighting-intent-router';

export interface FastLightingScope {
  tenantId: string;
  siteId: string;
}

export type LightingAction = 'turn_on' | 'turn_off';

export type LightingTargetResolution =
  | { status: 'resolved'; deviceId: string }
  | { status: 'ambiguous' | 'not_found' | 'unavailable' };

export type LightingExecutionResult =
  | { status: 'confirmed'; traceId?: string }
  | { status: 'denied'; reason?: string; traceId?: string }
  | { status: 'not_confirmed'; traceId?: string };

export interface FastLightingActionGateway {
  listTrustedRooms(
    scope: FastLightingScope,
  ): Promise<readonly LightingRoomAlias[]>;

  resolveTarget(
    scope: FastLightingScope,
    roomId: string,
  ): Promise<LightingTargetResolution>;

  execute(
    scope: FastLightingScope,
    deviceId: string,
    action: LightingAction,
  ): Promise<LightingExecutionResult>;
}

export type FastLightingResult =
  | {
      kind: 'delegate';
      reason: 'ambiguous' | 'unsupported';
    }
  | {
      kind: 'handled';
      outcome:
        | 'confirmed'
        | 'denied'
        | 'not_confirmed'
        | 'unresolved'
        | 'failed';
      reply: string;
      traceId?: string;
    };

const REPLIES = {
  turn_on: 'Готово, светнах лампата.',
  turn_off: 'Готово, изгасих лампата.',
  denied: 'Нямам разрешение да управлявам тази лампа.',
  not_confirmed: 'Не успях да потвърдя промяната на лампата.',
  unresolved: 'Не мога да определя еднозначно коя лампа имаш предвид.',
  failed: 'Възникна проблем при управлението на лампата.',
} as const;

/**
 * Application orchestration only.
 *
 * Does not interpret arbitrary LLM output, authorize hardware,
 * implement protocols, retry commands, or infer device identities.
 */
export class FastLightingCommandUseCase {
  constructor(
    private readonly gateway: FastLightingActionGateway,
  ) {}

  async handle(
    scope: FastLightingScope,
    message: string,
  ): Promise<FastLightingResult> {
    if (!scope?.tenantId?.trim() || !scope?.siteId?.trim()) {
      return {
        kind: 'handled',
        outcome: 'denied',
        reply: REPLIES.denied,
      };
    }

    try {
      const rooms = await this.gateway.listTrustedRooms(scope);
      const route = routeLightingIntent(message, rooms);

      if (route.kind === 'delegate') {
        return route;
      }

      const target = await this.gateway.resolveTarget(
        scope,
        route.roomId,
      );

      // A parsed command is never converted into a guessed device ID.
      // Do not delegate to an executing LLM after target resolution fails.
      if (target.status !== 'resolved' || !target.deviceId.trim()) {
        return {
          kind: 'handled',
          outcome: 'unresolved',
          reply: REPLIES.unresolved,
        };
      }

      // Exactly one execution attempt per invocation.
      // No automatic retry: the command might have reached hardware.
      const result = await this.gateway.execute(
        scope,
        target.deviceId,
        route.action,
      );

      switch (result.status) {
        case 'confirmed':
          return {
            kind: 'handled',
            outcome: 'confirmed',
            reply: REPLIES[route.action],
            traceId: result.traceId,
          };

        case 'denied':
          return {
            kind: 'handled',
            outcome: 'denied',
            reply: REPLIES.denied,
            traceId: result.traceId,
          };

        case 'not_confirmed':
          return {
            kind: 'handled',
            outcome: 'not_confirmed',
            reply: REPLIES.not_confirmed,
            traceId: result.traceId,
          };

        default:
          return {
            kind: 'handled',
            outcome: 'failed',
            reply: REPLIES.failed,
          };
      }
    } catch {
      // Never fall back to another executing path after a
      // possible hardware command failure.
      return {
        kind: 'handled',
        outcome: 'failed',
        reply: REPLIES.failed,
      };
    }
  }
}
