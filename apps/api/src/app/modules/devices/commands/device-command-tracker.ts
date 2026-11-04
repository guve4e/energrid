import type { DeviceExecutionTrace, RegisteredDeviceState } from '../device-registry.types';
import type { ExecutionDiagnosis } from '../investigation/device-execution-diagnosis';
import type { OperationalLogEntry } from '../operational-log.service';

export const DEVICE_COMMAND_TRACKER = Symbol('DEVICE_COMMAND_TRACKER');
export type DeviceCommand = NonNullable<RegisteredDeviceState['command']>;
export type CommandValues = Record<string, number | boolean | string | null>;
export interface CommandScope { tenantId: string; siteId: string }
export interface CommandRequest {
  /** Ownership comes from the enrolled device, never from client input. */
  scope: CommandScope;
  action: DeviceCommand['action'];
  expectedValues: CommandValues;
  message?: string;
  ttlMs?: number;
  actor?: { type: 'user' | 'assistant' | 'automation' | 'system'; id?: string; name?: string };
}
export interface CommandPublication { topic?: string; adapter?: string }
export interface CommandClock { now(): number }
export interface CommandTrackerSettings {
  ackTimeoutMs(): number;
  settleWindowMs(): number;
  traceLimit(): number;
}
export interface CommandEventSink {
  record(entry: Omit<OperationalLogEntry, 'id' | 'observedAt'>): unknown;
}
export interface ExecutionDiagnosisProvider {
  investigate(trace: Pick<DeviceExecutionTrace, 'outcome' | 'deviceId'> & { stages?: DeviceExecutionTrace['stages'] }): ExecutionDiagnosis;
}

/** Registry-facing contract. Publication is not acknowledgement; observation drives verification. */
export interface DeviceCommandTracker {
  markDeviceCommandPending(deviceId: string, command: CommandRequest): DeviceCommand;
  markDeviceCommandPublished(deviceId: string, commandId: string, evidence?: CommandPublication): DeviceExecutionTrace | null;
  markDeviceCommandTransportFailed(deviceId: string, commandId: string, message: string): DeviceExecutionTrace | null;
  markDeviceCommandFailed(deviceId: string, commandId: string, reason: 'pre_write' | 'readback_mismatch', message: string): DeviceCommand | null;
  getCommand(deviceId: string, scope: CommandScope): DeviceCommand | undefined;
  getExecutionTraces(scope: CommandScope, limit?: number): DeviceExecutionTrace[];
  getLatestExecutionTrace(deviceId: string, scope: CommandScope): DeviceExecutionTrace | null;
  observeTelemetry(deviceId: string, values: CommandValues, observedAt: string, evidenceCommandId: string | null, scope: CommandScope, reason?: string): void;
}
