import type { DeviceExecutionTrace, RegisteredDeviceState } from '../device-registry.types';
import type { ExecutionDiagnosis } from '../investigation/device-execution-diagnosis';
import type { OperationalLogEntry } from '../operational-log.service';

export const DEVICE_COMMAND_TRACKER = Symbol('DEVICE_COMMAND_TRACKER');
export type DeviceCommand = NonNullable<RegisteredDeviceState['command']>;
export type CommandValues = Record<string, number | boolean | string | null>;
export interface CommandRequest {
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
  investigate(trace: Pick<DeviceExecutionTrace, 'outcome' | 'deviceId'>): ExecutionDiagnosis;
}

/** Registry-facing contract. Publication is not acknowledgement; observation drives verification. */
export interface DeviceCommandTracker {
  markDeviceCommandPending(deviceId: string, command: CommandRequest): DeviceCommand;
  markDeviceCommandPublished(deviceId: string, commandId: string, evidence?: CommandPublication): DeviceExecutionTrace | null;
  markDeviceCommandTransportFailed(deviceId: string, commandId: string, message: string): DeviceExecutionTrace | null;
  markDeviceCommandFailed(deviceId: string, command: Pick<CommandRequest, 'action' | 'expectedValues' | 'message'>): DeviceCommand;
  getCommand(deviceId: string): DeviceCommand | undefined;
  getExecutionTraces(limit?: number): DeviceExecutionTrace[];
  getLatestExecutionTrace(deviceId: string): DeviceExecutionTrace | null;
  observeTelemetry(deviceId: string, values: CommandValues, observedAt: string, evidenceCommandId: string | null, reason?: string): void;
}
