import {
  currentInteractionTrace,
} from '../observability/interaction-trace-context';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { DEVICE_ENROLLMENT_SERVICE } from './enrollment/device-enrollment.module';
import { DeviceEnrollmentService } from './enrollment/device-enrollment.service';
import { DeviceInstallationStore } from './device-installation.store';
import { DeviceRegistryService } from './device-registry.service';
import { DeviceControlService } from './device-control.service';
import { authorizeInstantLightingAction } from './device-assistant-action-policy';
import {
  InteractionTraceSession,
  type InteractionOutcome,
} from '../observability/interaction-trace';
import { FileInteractionTraceStore } from '../observability/file-interaction-trace.store';

export interface LightingActionScope {
  tenantId: string;
  siteId: string;
}

@Injectable()
export class DeviceAssistantLightingService {
  private readonly logger = new Logger(DeviceAssistantLightingService.name);
  constructor(
    private readonly registry: DeviceRegistryService,
    private readonly installations: DeviceInstallationStore,
    @Inject(DEVICE_ENROLLMENT_SERVICE)
    private readonly enrollment: DeviceEnrollmentService,
    private readonly controls: DeviceControlService,
  ) {}

  async executeTraced(
    scope: LightingActionScope,
    deviceId: string,
    action: 'turn_on' | 'turn_off',
  ) {
    const active = currentInteractionTrace();

    if (active && active.matchesScope(scope)) {
      try {
        const result = await active.measure(
          'core.command',
          () => this.execute(scope, deviceId, action, active),
        );

        if (result.status === 'denied') {
          active.recordOutcome('denied');
        } else if (result.status !== 'confirmed') {
          active.recordOutcome('failed');
        }

        return { ...result, traceId: active.traceId };
      } catch (error) {
        active.recordOutcome('failed');
        throw error;
      }
    }

    // Preserve the original executor's invalid-scope handling.
    if (!scope?.tenantId?.trim() || !scope?.siteId?.trim()) {
      return this.execute(scope, deviceId, action);
    }

    const trace = new InteractionTraceSession(
      scope,
      'chat',
      new FileInteractionTraceStore(),
    );

    let outcome: InteractionOutcome = 'failed';

    try {
      const result = await trace.measure(
        'core.command',
        () => this.execute(scope, deviceId, action, trace),
      );

      outcome =
        result.status === 'confirmed'
          ? 'succeeded'
          : result.status === 'denied'
            ? 'denied'
            : 'failed';

      return { ...result, traceId: trace.traceId };
    } finally {
      try {
        await trace.finish(outcome);
      } catch {
        // Tracing must never turn an executed hardware command
        // into a reported failure.
        this.logger.warn(
          'Interaction trace persistence failed',
        );
      }
    }
  }

  async execute(
    scope: LightingActionScope,
    deviceId: string,
    action: 'turn_on' | 'turn_off',
    trace?: InteractionTraceSession,
  ) {
    if (
      !scope?.tenantId?.trim() ||
      !scope?.siteId?.trim() ||
      !deviceId?.trim() ||
      !['turn_on', 'turn_off'].includes(action)
    ) {
      return { status: 'denied' as const, reason: 'invalid_request' };
    }

    const start = performance.now();
    await this.registry.ensureInstallationsLoaded();
    const registryMs = performance.now() - start;

    // ControlService currently executes by device ID.
    // Require a globally unambiguous registry identity.
    const matches = this.registry.getDevices().filter(
      item => item.id === deviceId,
    );

    if (matches.length !== 1) {
      return { status: 'denied' as const, reason: 'ambiguous_device' };
    }

    const device = matches[0];

    if (
      device.tenantId !== scope.tenantId ||
      device.siteId !== scope.siteId
    ) {
      return { status: 'denied' as const, reason: 'scope_mismatch' };
    }

    const installationStart = performance.now();
    const installation = await this.installations.get(
      scope.siteId,
      deviceId,
    );
    const installationMs = performance.now() - installationStart;

    if (
      !installation ||
      installation.device.id !== deviceId ||
      installation.device.tenantId !== scope.tenantId ||
      installation.device.siteId !== scope.siteId ||
      installation.device.trustStatus !== 'approved'
    ) {
      return { status: 'denied' as const, reason: 'installation_not_approved' };
    }

    // Fail closed if runtime and persisted installation disagree.
    if (
      installation.device.metadata?.loadType !== 'lighting' ||
      installation.device.assistantEnabled !== true ||
      installation.device.control?.binding?.enabled !== true
    ) {
      return { status: 'denied' as const, reason: 'installation_policy_mismatch' };
    }

    const enrollmentStart = performance.now();
    const enrolled = await this.enrollment.find({
      tenantId: scope.tenantId,
      siteId: scope.siteId,
      deviceId,
    });

    const enrollmentMs = performance.now() - enrollmentStart;

    // Explicit opt-in; an absent environment variable allows nothing.
    const allowlistedIds = new Set(
      (process.env.HOME_ASSISTANT_INSTANT_LIGHT_DEVICE_IDS || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean),
    );

    const policyStart = performance.now();
    const decision = authorizeInstantLightingAction(
      scope,
      device,
      action,
      enrolled?.status === 'enrolled',
      allowlistedIds,
    );

    const policyMs = performance.now() - policyStart;

    if (!decision.allowed) {
      this.logger.log(JSON.stringify({
        event: 'assistant.light.latency',
        outcome: 'denied',
        reason: decision.reason,
        totalMs: Math.round(performance.now() - start),
      }));
      return { status: 'denied' as const, reason: decision.reason };
    }

    // Only the deterministic Core may execute the physical command.
    const controlStart = performance.now();
    const result = trace
      ? await trace.measure(
          'device.execute',
          () => this.controls.execute(deviceId, action),
        )
      : await this.controls.execute(deviceId, action);
    const controlMs = performance.now() - controlStart;

    this.logger.log(JSON.stringify({
      event: 'assistant.light.latency',
      action,
      outcome: result.status,
      registryMs: Math.round(registryMs),
      installationMs: Math.round(installationMs),
      enrollmentMs: Math.round(enrollmentMs),
      policyMs: Math.round(policyMs),
      controlMs: Math.round(controlMs),
      totalMs: Math.round(performance.now() - start),
    }));

    return {
      status: result.status === 'success'
        ? 'confirmed' as const
        : 'not_confirmed' as const,
      deviceId,
      action,
      confirmation: 'none' as const,
      coreResult: result,
    };
  }
}
