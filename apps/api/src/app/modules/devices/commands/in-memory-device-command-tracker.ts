import type { DeviceExecutionTrace, DeviceExecutionTraceStage, RegisteredDeviceState } from '../device-registry.types';
import type { CommandClock, CommandEventSink, CommandTrackerSettings, DeviceCommandTracker, ExecutionDiagnosisProvider } from './device-command-tracker';

/** Owns command state and execution evidence; no transport, storage, or framework dependencies. */
export class InMemoryDeviceCommandTracker implements DeviceCommandTracker {
  private readonly commandByDeviceId = new Map<
    string,
    NonNullable<RegisteredDeviceState['command']> & {
      expiresAt: number;
      displayUntil: number;
    }
  >();

  private readonly executionTraceByCommandId = new Map<
    string,
    DeviceExecutionTrace & {
      expiresAt: number;
      settlingUntil: number | null;
      lastVerifiedValues: Record<
        string,
        number | boolean | string | null
      > | null;
    }
  >();

  private readonly latestCommandIdByDeviceId = new Map<string, string>();

  constructor(
    private readonly clock: CommandClock,
    private readonly settings: CommandTrackerSettings,
    private readonly executionInvestigator: ExecutionDiagnosisProvider,
    private readonly operationalLog?: CommandEventSink,
  ) {}

  getCommand(deviceId: string): NonNullable<RegisteredDeviceState['command']> | undefined {
    this.refreshDeviceCommand(deviceId);
    const command = this.commandByDeviceId.get(deviceId);
    return command ? commandForState(command) : undefined;
  }

  markDeviceCommandPending(
    deviceId: string,
    command: {
      action: NonNullable<RegisteredDeviceState['command']>['action'];
      expectedValues: Record<string, number | boolean | string | null>;
      message?: string;
      ttlMs?: number;
      actor?: {
        type: 'user' | 'assistant' | 'automation' | 'system';
        id?: string;
        name?: string;
      };
    },
  ): NonNullable<RegisteredDeviceState['command']> {
    const now = this.clock.now();
    const requestedAt = new Date(now).toISOString();

    const previousCommandId = this.latestCommandIdByDeviceId.get(deviceId);
    const previousTrace = previousCommandId
      ? this.executionTraceByCommandId.get(previousCommandId)
      : null;

    if (previousTrace?.outcome === 'running') {
      replaceActiveTraceStage(previousTrace, 'settling', {
        stage: 'settling',
        status: 'warning',
        observedAt: requestedAt,
        message: 'Stability window interrupted by a newer command.',
      });

      appendTraceStage(previousTrace, {
        stage: 'superseded',
        status: 'complete',
        observedAt: requestedAt,
        message: 'A newer command replaced this execution before completion.',
        evidence: {
          supersededByAction: command.action,
        },
      });

      this.completeExecutionTrace(previousTrace, 'superseded', requestedAt);
    }

    const pending = {
      id: `${deviceId}:${command.action}:${now}`,
      action: command.action,
      status: 'pending' as const,
      requestedAt,
      expectedValues: command.expectedValues,
      message: command.message,
      expiresAt:
        now +
        (command.ttlMs || this.settings.ackTimeoutMs()),
      displayUntil:
        now + this.settings.ackTimeoutMs() + 30000,
    };
    this.commandByDeviceId.set(deviceId, pending);

    const trace: DeviceExecutionTrace & {
      expiresAt: number;
      settlingUntil: number | null;
      lastVerifiedValues: Record<
        string,
        number | boolean | string | null
      > | null;
    } = {
      id: pending.id,
      commandId: pending.id,
      deviceId,

      actor: command.actor
        ? { ...command.actor }
        : { type: 'system', name: 'Energrid Control Service' },

      intent: command.message || 'Device command execution',

      action: command.action,
      expectedValues: { ...command.expectedValues },
      requestedAt,
      completedAt: null,
      outcome: 'running',
      durationMs: null,
      diagnosis: this.executionInvestigator.investigate({
        outcome: 'running',
        deviceId,
      }),
      expiresAt: pending.expiresAt,
      settlingUntil: null,
      lastVerifiedValues: null,
      stages: [
        {
          stage: 'requested',
          status: 'complete',
          observedAt: requestedAt,
          message: 'Command was accepted by the Energrid control service.',
          evidence: {
            expectedValues: { ...command.expectedValues },
          },
        },
      ],
    };

    this.executionTraceByCommandId.set(trace.commandId, trace);
    this.latestCommandIdByDeviceId.set(deviceId, trace.commandId);
    this.trimExecutionTraces();

    this.operationalLog?.record({
      level: 'info',
      source: 'device-control',
      event: 'command.pending',
      message: `${deviceId} ${command.action} requested; preparing transport.`,
      deviceId,
      status: 'pending',
      details: {
        action: command.action,
        expected: JSON.stringify(command.expectedValues),
      },
    });
    return commandForState(pending);
  }

  markDeviceCommandPublished(
    deviceId: string,
    commandId: string,
    evidence: {
      topic?: string;
      adapter?: string;
    } = {},
  ): DeviceExecutionTrace | null {
    const trace = this.executionTraceByCommandId.get(commandId);
    if (!trace || trace.deviceId !== deviceId) return null;
    if (trace.outcome !== 'running') return publicExecutionTrace(trace);

    appendTraceStage(trace, {
      stage: 'published',
      status: 'complete',
      observedAt: new Date(this.clock.now()).toISOString(),
      message: 'Command was published to the configured transport.',
      evidence,
    });

    return publicExecutionTrace(trace);
  }

  markDeviceCommandTransportFailed(
    deviceId: string,
    commandId: string,
    message: string,
  ): DeviceExecutionTrace | null {
    const trace = this.executionTraceByCommandId.get(commandId);
    if (!trace || trace.deviceId !== deviceId) return null;

    const now = new Date(this.clock.now()).toISOString();

    appendTraceStage(trace, {
      stage: 'transport_failed',
      status: 'failed',
      observedAt: now,
      message,
    });

    this.completeExecutionTrace(trace, 'failed', now);
    return publicExecutionTrace(trace);
  }

  getExecutionTraces(limit = 50): DeviceExecutionTrace[] {
    this.refreshExecutionTraces();

    return [...this.executionTraceByCommandId.values()]
      .sort(
        (left, right) =>
          Date.parse(right.requestedAt) - Date.parse(left.requestedAt),
      )
      .slice(0, Math.max(1, limit))
      .map(publicExecutionTrace);
  }

  getLatestExecutionTrace(deviceId: string): DeviceExecutionTrace | null {
    this.refreshExecutionTraces();

    const commandId = this.latestCommandIdByDeviceId.get(deviceId);
    if (!commandId) return null;

    const trace = this.executionTraceByCommandId.get(commandId);
    return trace ? publicExecutionTrace(trace) : null;
  }

  markDeviceCommandFailed(
    deviceId: string,
    command: {
      action: NonNullable<RegisteredDeviceState['command']>['action'];
      expectedValues: Record<string, number | boolean | string | null>;
      message?: string;
    },
  ): NonNullable<RegisteredDeviceState['command']> {
    const now = this.clock.now();
    const failed = {
      id: `${deviceId}:${command.action}:${now}`,
      action: command.action,
      status: 'failed' as const,
      requestedAt: new Date(now).toISOString(),
      expectedValues: command.expectedValues,
      message: command.message,
      expiresAt: now,
      displayUntil: now + 30000,
    };
    this.commandByDeviceId.set(deviceId, failed);
    this.operationalLog?.record({
      level: 'error',
      source: 'device-control',
      event: 'command.failed',
      message: `${deviceId} ${command.action} failed: ${command.message || 'unknown error'}`,
      deviceId,
      status: 'failed',
      details: {
        action: command.action,
        expected: JSON.stringify(command.expectedValues),
      },
    });
    return commandForState(failed);
  }

  observeTelemetry(
    deviceId: string,
    values: Record<string, number | boolean | string | null>,
    observedAt: string,
    evidenceCommandId: string | null,
    reason?: string,
  ): void {
    this.refreshDeviceCommand(deviceId);
    this.refreshExecutionTraces();

    const command = this.commandByDeviceId.get(deviceId);
    if (!command || command.status !== 'pending') {
      this.observePossibleDrift(deviceId, values, observedAt);
      return;
    }

    const trace = this.executionTraceByCommandId.get(command.id);

    if (evidenceCommandId && evidenceCommandId !== command.id) {
      return;
    }

    const telemetryTime = Date.parse(observedAt);
    const requestedTime = Date.parse(command.requestedAt);

    if (
      Number.isFinite(telemetryTime) &&
      Number.isFinite(requestedTime) &&
      telemetryTime < requestedTime
    ) {
      if (trace) {
        appendTraceStage(trace, {
          stage: 'stale',
          status: 'warning',
          observedAt: new Date(this.clock.now()).toISOString(),
          message:
            'Telemetry was older than the command and could not verify it.',
          evidence: {
            telemetryObservedAt: observedAt,
            requestedAt: command.requestedAt,
          },
        });
      }

      return;
    }

    if (!valuesMatch(command.expectedValues, values)) {
      if (trace && evidenceCommandId === command.id) {
        appendTraceStage(trace, {
          stage: 'mismatched',
          status: 'warning',
          observedAt: new Date(this.clock.now()).toISOString(),
          message:
            'Device reported state, but it did not match the requested values.',
          evidence: {
            expectedValues: { ...command.expectedValues },
            reportedValues: { ...values },
            reason: reason || null,
          },
        });
      }

      return;
    }

    const now = this.clock.now();
    const nowIso = new Date(now).toISOString();

    this.commandByDeviceId.set(deviceId, {
      ...command,
      status: 'acked',
      message: 'Device reported the requested state.',
      displayUntil: now + 5000,
    });

    if (trace) {
      appendTraceStage(trace, {
        stage: 'reported',
        status: 'complete',
        observedAt,
        message: 'Matching device telemetry was received.',
        evidence: {
          reportedValues: { ...values },
          sourceReason: reason || null,
          commandId: evidenceCommandId,
        },
      });

      appendTraceStage(trace, {
        stage: 'verified',
        status: 'complete',
        observedAt: nowIso,
        message: 'Registry verified that observed values matched the request.',
        evidence: {
          expectedValues: { ...command.expectedValues },
          reportedValues: { ...values },
        },
      });

      const settleMs = this.settings.settleWindowMs();

      trace.settlingUntil = now + settleMs;
      trace.lastVerifiedValues = { ...values };

      appendTraceStage(trace, {
        stage: 'settling',
        status: 'active',
        observedAt: nowIso,
        message: `Waiting ${settleMs}ms to ensure the device remains stable.`,
        evidence: {
          settleWindowMs: settleMs,
        },
      });
    }

    this.operationalLog?.record({
      level: 'info',
      source: 'device-registry',
      event: 'command.acked',
      message: `${deviceId} reported the requested state.`,
      deviceId,
      status: 'acked',
      details: {
        action: command.action,
        expected: JSON.stringify(command.expectedValues),
        commandId: command.id,
      },
    });
  }

  private observePossibleDrift(
    deviceId: string,
    values: Record<string, number | boolean | string | null>,
    observedAt: string,
  ): void {
    const commandId = this.latestCommandIdByDeviceId.get(deviceId);
    if (!commandId) return;

    const trace = this.executionTraceByCommandId.get(commandId);
    if (!trace || trace.outcome !== 'running') return;
    if (!trace.settlingUntil) return;

    if (valuesMatch(trace.expectedValues, values)) return;

    appendTraceStage(trace, {
      stage: 'drifted',
      status: 'failed',
      observedAt,
      message: 'Device moved away from the requested state during settling.',
      evidence: {
        expectedValues: { ...trace.expectedValues },
        observedValues: { ...values },
      },
    });

    this.completeExecutionTrace(trace, 'drifted', observedAt);
  }

  private completeExecutionTrace(
    trace: DeviceExecutionTrace & {
      expiresAt: number;
      settlingUntil: number | null;
      lastVerifiedValues: Record<
        string,
        number | boolean | string | null
      > | null;
    },
    outcome: Exclude<DeviceExecutionTrace['outcome'], 'running'>,
    completedAt: string,
  ): void {
    completeTrace(trace, outcome, completedAt);
    trace.diagnosis = this.executionInvestigator.investigate(trace);
  }

  private refreshExecutionTraces(): void {
    const now = this.clock.now();

    for (const trace of this.executionTraceByCommandId.values()) {
      if (trace.outcome !== 'running') continue;

      if (trace.settlingUntil && now >= trace.settlingUntil) {
        const completedAt = new Date(trace.settlingUntil).toISOString();

        replaceActiveTraceStage(trace, 'settling', {
          stage: 'settling',
          status: 'complete',
          observedAt: completedAt,
          message:
            'The stability window completed without contradictory telemetry.',
          evidence: {
            settleWindowCompletedAt: completedAt,
          },
        });

        appendTraceStage(trace, {
          stage: 'settled',
          status: 'complete',
          observedAt: completedAt,
          message: 'The device remained at the requested state.',
        });

        this.completeExecutionTrace(trace, 'settled', completedAt);
        continue;
      }

      if (!trace.settlingUntil && now > trace.expiresAt) {
        const completedAt = new Date(trace.expiresAt).toISOString();

        appendTraceStage(trace, {
          stage: 'timed_out',
          status: 'failed',
          observedAt: completedAt,
          message:
            'No matching telemetry arrived before the acknowledgement deadline.',
          evidence: {
            expectedValues: { ...trace.expectedValues },
          },
        });

        this.completeExecutionTrace(trace, 'timed_out', completedAt);
      }
    }
  }

  private trimExecutionTraces(): void {
    const maxTraces = this.settings.traceLimit();

    const traces = [...this.executionTraceByCommandId.values()].sort(
      (left, right) =>
        Date.parse(right.requestedAt) - Date.parse(left.requestedAt),
    );

    for (const trace of traces.slice(maxTraces)) {
      this.executionTraceByCommandId.delete(trace.commandId);

      if (
        this.latestCommandIdByDeviceId.get(trace.deviceId) === trace.commandId
      ) {
        this.latestCommandIdByDeviceId.delete(trace.deviceId);
      }
    }
  }

  private refreshDeviceCommand(deviceId: string): void {
    const command = this.commandByDeviceId.get(deviceId);
    if (!command) return;

    const now = this.clock.now();
    if (command.status === 'pending' && now > command.expiresAt) {
      this.commandByDeviceId.set(deviceId, {
        ...command,
        status: 'no_ack',
        message: 'Command was published, but no matching telemetry arrived.',
        displayUntil: now + 30000,
      });
      this.operationalLog?.record({
        level: 'warn',
        source: 'device-registry',
        event: 'command.no_ack',
        message: `${deviceId} did not report the requested state after command publish.`,
        deviceId,
        status: 'no_ack',
        details: {
          action: command.action,
          expected: JSON.stringify(command.expectedValues),
        },
      });
      return;
    }

    if (command.status !== 'pending' && now > command.displayUntil) {
      this.commandByDeviceId.delete(deviceId);
    }
  }
}

function appendTraceStage(
  trace: DeviceExecutionTrace,
  stage: DeviceExecutionTraceStage,
): void {
  const previous = trace.stages.at(-1);

  if (previous?.stage === stage.stage && previous.status === stage.status) {
    return;
  }

  trace.stages.push(stage);
}

function replaceActiveTraceStage(
  trace: DeviceExecutionTrace,
  stageName: DeviceExecutionTraceStage['stage'],
  replacement: DeviceExecutionTraceStage,
): void {
  let index = -1;

  for (
    let candidate = trace.stages.length - 1;
    candidate >= 0;
    candidate -= 1
  ) {
    const stage = trace.stages[candidate];

    if (stage.stage === stageName && stage.status === 'active') {
      index = candidate;
      break;
    }
  }

  if (index >= 0) {
    trace.stages[index] = replacement;
    return;
  }

  appendTraceStage(trace, replacement);
}

function completeTrace(
  trace: DeviceExecutionTrace,
  outcome: DeviceExecutionTrace['outcome'],
  completedAt: string,
): void {
  trace.outcome = outcome;
  trace.completedAt = completedAt;

  const started = Date.parse(trace.requestedAt);
  const completed = Date.parse(completedAt);

  trace.durationMs =
    Number.isFinite(started) && Number.isFinite(completed)
      ? Math.max(0, completed - started)
      : null;
}

function publicExecutionTrace(
  trace: DeviceExecutionTrace,
): DeviceExecutionTrace {
  return {
    id: trace.id,
    commandId: trace.commandId,
    deviceId: trace.deviceId,

    actor: { ...trace.actor },

    action: trace.action,
    expectedValues: { ...trace.expectedValues },
    requestedAt: trace.requestedAt,
    completedAt: trace.completedAt,
    outcome: trace.outcome,
    durationMs: trace.durationMs,
    diagnosis: trace.diagnosis,
    stages: trace.stages.map((stage) => ({
      ...stage,
      evidence: stage.evidence ? { ...stage.evidence } : undefined,
    })),
  };
}

function commandForState(
  command: NonNullable<RegisteredDeviceState['command']> & {
    expiresAt?: number;
    displayUntil?: number;
  },
): NonNullable<RegisteredDeviceState['command']> {
  return {
    id: command.id,
    action: command.action,
    status: command.status,
    requestedAt: command.requestedAt,
    expectedValues: command.expectedValues,
    message: command.message,
  };
}

function valuesMatch(
  expected: Record<string, number | boolean | string | null>,
  actual: Record<string, number | boolean | string | null>,
): boolean {
  return Object.entries(expected).every(
    ([key, value]) => actual[key] === value,
  );
}
