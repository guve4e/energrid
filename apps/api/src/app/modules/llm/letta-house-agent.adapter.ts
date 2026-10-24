import {
  currentInteractionTrace,
} from '../observability/interaction-trace-context';
import {
  instrumentLocalTools,
} from '../observability/instrument-local-tools';
import { DeviceIntelligenceQueryService } from '../devices/device-intelligence-query.service';
import { DeviceAssistantLightingService } from '../devices/device-assistant-lighting.service';
import { Injectable, Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { LettaAgentClient, type AnyAgentTool } from '@letta-ai/letta-agent-sdk';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  HouseAgentPort,
  HouseAgentReply,
  HouseAgentScope,
} from './house-agent.port';
import { DeviceRegistryService } from '../devices/device-registry.service';
import { DeviceControlService } from '../devices/device-control.service';
import { ApprovedMqttObservationRuntime } from '../devices/mqtt/approved-mqtt-observation.runtime';

export function houseAgentScopeKey(scope: HouseAgentScope): string {
  if (!scope.tenantId?.trim() || !scope.siteId?.trim()) {
    throw new Error('Tenant and site are required');
  }

  return createHash('sha256')
    .update(JSON.stringify([scope.tenantId, scope.siteId]))
    .digest('hex');
}

@Injectable()
export class LettaHouseAgentAdapter implements HouseAgentPort {
  private readonly logger = new Logger(LettaHouseAgentAdapter.name);
  private readonly client = new LettaAgentClient({ backend: 'local' });
  private readonly agentPromises = new Map<string, Promise<string>>();
  private readonly queues = new Map<string, Promise<HouseAgentReply>>();

  constructor(
    private readonly registry: DeviceRegistryService,
    private readonly controls: DeviceControlService,
    private readonly observations: ApprovedMqttObservationRuntime,
    private readonly intelligence: DeviceIntelligenceQueryService,
    private readonly assistantLighting: DeviceAssistantLightingService,
  ) {}

  private async agentFor(scope: HouseAgentScope): Promise<string> {
    const key = houseAgentScopeKey(scope);
    const existing = this.agentPromises.get(key);
    if (existing) return existing;

    const creating = this.loadOrCreateAgent(key);
    this.agentPromises.set(key, creating);

    try {
      return await creating;
    } catch (error) {
      this.agentPromises.delete(key);
      throw error;
    }
  }

  private async loadOrCreateAgent(key: string): Promise<string> {
    const directory = join(homedir(), '.energrid', 'letta');
    const file = join(directory, `${key}.json`);

    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as {
        agentId?: string;
      };

      if (!saved.agentId?.startsWith('agent-')) {
        throw new Error('Invalid persisted Letta agent reference');
      }

      return saved.agentId;
    }

    mkdirSync(directory, { recursive: true, mode: 0o700 });

    const agentId = await this.client.createAgent({
      name: `energrid-house-${key.slice(0, 12)}`,
      persona: [
        'You are Energrid, a conversational intelligence for a home.',
        'You understand the home, its networks, rooms, energy systems and devices.',
        'Speak naturally in the language the user uses.',
        'Remember useful durable information from conversations.',
        'Distinguish installer-reported knowledge from measured facts.',
        'Never invent a sensor reading, verified connection, or device capability.',
        'Ask clarification only when it is useful; do not repeat answered questions.',
        'Do not claim you have operated or inspected a device unless a trusted tool did so.',
        'You may explain and propose actions, but device execution belongs to Energrid Core.',
        'Use Energrid device tools for measured readings and device actions. A measurement is usable only when its tool result includes an approved reading and freshness metadata.',
        'Do not describe stale or invalid measurements as current. Report their timestamp and stale status instead.',
      ].join(' '),
      baseTools: [],
      skillSources: [],
    });

    writeFileSync(file, JSON.stringify({ agentId }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });

    return agentId;
  }

  async talk(scope: HouseAgentScope, text: string): Promise<HouseAgentReply> {
    const key = houseAgentScopeKey(scope);

    if (!text.trim() || text.length > 4000) {
      throw new Error('Message must contain 1–4000 characters');
    }

    // Serialize conversation turns for the same house.
    const previous = this.queues.get(key);
    const work = (previous ? previous.catch(() => undefined) : Promise.resolve())
      .then(() => this.runTurn(scope, text));

    this.queues.set(key, work);

    try {
      return await work;
    } finally {
      if (this.queues.get(key) === work) this.queues.delete(key);
    }
  }

  private async runTurn(
    scope: HouseAgentScope,
    text: string,
  ): Promise<HouseAgentReply> {
    const turnStart = performance.now();
    const activeTrace = currentInteractionTrace();
    const agentId = activeTrace?.matchesScope(scope)
      ? await activeTrace.measure(
          'assistant.agent_setup',
          () => this.agentFor(scope),
        )
      : await this.agentFor(scope);

    // Only scoped Energrid observation and Core control tools are available.
    const session = this.client.resumeSession(agentId, {
      allowedTools: [
          'list_devices',
          'describe_device',
          'resolve_device_target',
          'execute_approved_lighting_action',
          'propose_device_installation',
          'read_device_observation',
          'read_room_measurement',
          'control_device',
        ],
      toolset: { base: 'none' },
      permissionMode: 'strict',
      skillSources: [],
      tools: instrumentLocalTools(
        scope,
        this.deviceTools(scope),
      ),
      canUseTool: async (toolName) => (
        (
          toolName === 'list_devices' ||
          toolName === 'describe_device' ||
          toolName === 'resolve_device_target' ||
          toolName === 'execute_approved_lighting_action' ||
          toolName === 'propose_device_installation' ||
          toolName === 'read_device_observation' ||
          toolName === 'read_room_measurement'
        )
          ? { behavior: 'allow' as const }
          : {
              behavior: 'deny' as const,
              message: 'Device control is not authorized in this session',
            }
      ),
    });

    try {
      await session.send(text);

      for await (const event of session.stream()) {
        if (event.type !== 'result') continue;

        if (!event.success) {
          throw new Error(
            `Letta conversation failed: ${event.errorCode || 'unknown'}`,
          );
        }

        return {
          text: event.result || '',
          conversationId: event.conversationId ?? agentId,
        };
      }

      throw new Error('Letta conversation ended without a result');
    } finally {
      session.close();
      this.logger.log(JSON.stringify({
        event: 'house_agent.turn.latency',
        totalMs: Math.round(performance.now() - turnStart),
      }));
    }
  }

  private deviceTools(scope: HouseAgentScope): AnyAgentTool[] {
    return [
      {
        name: 'list_devices',
        label: 'List enrolled Energrid devices',
        description: 'Discover devices enrolled at this site and their declared capabilities. This does not read live state or authorize control.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        execute: async () => {
          const devices = await this.intelligence.listDevices(scope);
          return toolResult({ count: devices.length, devices });
        },
      },
      {
        name: 'describe_device',
        label: 'Describe an enrolled Energrid device',
        description: 'Find an enrolled device by exact ID or unambiguous friendly name and return its declared capabilities and assistant permission. Does not read live state.',
        parameters: {
          type: 'object',
          properties: {
            device: {
              type: 'string',
              description: 'Exact device ID or unambiguous friendly name',
            },
          },
          required: ['device'],
          additionalProperties: false,
        },
        execute: async (_toolCallId, raw) => {
          const args = raw && typeof raw === 'object'
            ? raw as { device?: unknown }
            : {};
          if (typeof args.device !== 'string' || !args.device.trim())
            return toolError('Device name or ID required.');

          const device = await this.intelligence.describeDevice(
            scope,
            args.device,
          );

          return device
            ? toolResult(device)
            : toolError('No unambiguous enrolled device matched.');
        },
      },
      {
        name: 'resolve_device_target',
        label: 'Resolve an Energrid device target',
        description: 'Resolve a device through deterministic Energrid Core using durable enrollment, approved installation metadata, room, load purpose, and assistant permissions. Use this before interpreting a request such as "kitchen lights". For an exact ID or name use kind=exact and identifier. For kitchen lights use kind=room-load, room=kitchen, loadType=lighting. A resolved target is NOT permission to execute an action. Never guess when resolution returns not_found, blocked or ambiguous.',
        parameters: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['exact', 'room-load'],
            },
            identifier: {
              type: 'string',
              description: 'Device ID or friendly name for exact resolution.',
            },
            room: {
              type: 'string',
              description: 'Room name for room-load resolution.',
            },
            loadType: {
              type: 'string',
              enum: ['lighting'],
            },
          },
          required: ['kind'],
          additionalProperties: false,
        },
        execute: async (_toolCallId, raw) => {
          const args = raw && typeof raw === 'object' && !Array.isArray(raw)
            ? raw as Record<string, unknown>
            : {};

          if (args.kind === 'exact') {
            if (
              typeof args.identifier !== 'string' ||
              !args.identifier.trim()
            ) {
              return toolError('An exact device name or ID is required.');
            }

            const resolution = await this.intelligence.resolveTarget(
              scope,
              { kind: 'exact', identifier: args.identifier },
            );

            return toolResult(resolution);
          }

          if (args.kind === 'room-load') {
            if (
              typeof args.room !== 'string' ||
              !args.room.trim() ||
              args.loadType !== 'lighting'
            ) {
              return toolError(
                'A room and an approved lighting load type are required.',
              );
            }

            const resolution = await this.intelligence.resolveTarget(
              scope,
              {
                kind: 'room-load',
                room: args.room,
                loadType: 'lighting',
              },
            );

            return toolResult(resolution);
          }

          return toolError('Unsupported device target request.');
        },
      },
      {
        name: 'propose_device_installation',
        label: 'Propose device installation changes',
        description: 'Prepare a read-only installation proposal for an existing enrolled device. Use an exact enrolled device name or ID. Supply the proposed friendly name and room. Optionally classify its controlled load as lighting. Do not claim the load is physically verified. This tool stores a pending proposal but NEVER modifies or approves the device installation.',
        parameters: {
          type: 'object',
          properties: {
            device: {
              type: 'string',
              description: 'Exact enrolled device ID or friendly name.',
            },
            displayName: {
              type: 'string',
              description: 'New human-friendly device name.',
            },
            zoneName: {
              type: 'string',
              description: 'Room where the device is installed.',
            },
            loadType: {
              type: 'string',
              enum: ['lighting'],
              description: 'Optional proposed controlled-load type.',
            },
          },
          required: ['device', 'displayName', 'zoneName'],
          additionalProperties: false,
        },
        execute: async (_toolCallId, raw) => {
          const args = raw && typeof raw === 'object' &&
            !Array.isArray(raw)
            ? raw as Record<string, unknown>
            : {};

          if (
            typeof args.device !== 'string' ||
            typeof args.displayName !== 'string' ||
            typeof args.zoneName !== 'string' ||
            (args.loadType !== undefined &&
              args.loadType !== 'lighting')
          ) {
            return toolError('Invalid installation proposal parameters.');
          }

          const proposal =
            await this.intelligence.createInstallationProposal(
              scope,
              {
                device: args.device,
                displayName: args.displayName,
                zoneName: args.zoneName,
                ...(args.loadType === 'lighting'
                  ? { loadType: 'lighting' as const }
                  : {}),
              },
            );

          return toolResult(proposal);
        },
      },
      {
        name: 'execute_approved_lighting_action',
        label: 'Operate an explicitly approved lighting circuit',
        description: 'Execute an explicit user request to turn an approved light on or off. First resolve the exact device through resolve_device_target. Pass the resolved device ID, never a guessed ID. Energrid Core independently validates site, enrollment, lighting classification, assistant permission, control route and instant-action opt-in. Do not use for heat pumps, boilers, general switches or configuration changes. Report success only when Core returns status=confirmed. This operation can immediately change physical lighting.',
        parameters: {
          type: 'object',
          properties: {
            deviceId: {
              type: 'string',
              description: 'Exact device ID returned by Core resolution.',
            },
            action: {
              type: 'string',
              enum: ['turn_on', 'turn_off'],
            },
          },
          required: ['deviceId', 'action'],
          additionalProperties: false,
        },
        execute: async (_toolCallId, raw) => {
          const args = raw && typeof raw === 'object' &&
            !Array.isArray(raw)
            ? raw as Record<string, unknown>
            : {};

          if (
            typeof args.deviceId !== 'string' ||
            !args.deviceId.trim() ||
            (args.action !== 'turn_on' && args.action !== 'turn_off')
          ) {
            return toolError('Exact device ID and on/off action required.');
          }

          try {
            const result = await this.assistantLighting.executeTraced(
              scope,
              args.deviceId,
              args.action,
            );

            return toolResult(result);
          } catch (error) {
            return toolError(
              error instanceof Error
                ? error.message
                : 'Energrid Core could not complete the lighting action.',
            );
          }
        },
      },
      {
        name: 'read_room_measurement',
        label: 'Read a room measurement from Core',
        description: 'For a user asking the current temperature or humidity in a room, call this tool. Supply the room as named by the user (including Bulgarian names such as кухнята or Latin transliteration kuhnqta) and metric=temperature or humidity. Core resolves the room within the authenticated tenant/site, requires exactly one approved enrolled device, and returns the authorized Core measurement with unit, source timestamp and freshness. Never answer from memory, registry display state or PostgreSQL history. If status is stale, report the value as stale with its timestamp; if unavailable, explain that Core has no currently authorized reading.',
        parameters: {
          type: 'object',
          properties: {
            room: { type: 'string', description: 'Room named by the user, e.g. кухнята, kuhnqta, or kitchen.' },
            metric: { type: 'string', enum: ['temperature', 'humidity'] },
          },
          required: ['room', 'metric'],
          additionalProperties: false,
        },
        execute: async (_toolCallId, raw) => {
          const args = raw && typeof raw === 'object' && !Array.isArray(raw)
            ? raw as { room?: unknown; metric?: unknown }
            : {};
          if (typeof args.room !== 'string' ||
              (args.metric !== 'temperature' && args.metric !== 'humidity')) {
            return toolError('A room and either temperature or humidity are required.');
          }
          const result = await this.intelligence.readRoomMeasurement(
            scope,
            args.room,
            args.metric,
          );
          return toolResult(result);
        },
      },
      {
        name: 'read_device_observation',
        label: 'Read an approved device observation',
        description: 'Read authorized device measurements through Energrid Core Intelligence. Returns field values, source provenance, timestamps, and freshness. Never infer missing or stale measurements.',
        parameters: {
          type: 'object',
          properties: {
            device: {
              type: 'string',
              description: 'Exact enrolled device ID or unambiguous friendly name.',
            },
          },
          required: ['device'],
          additionalProperties: false,
        },
        execute: async (_toolCallId, raw) => {
          const args = raw && typeof raw === 'object' && !Array.isArray(raw)
            ? raw as { device?: unknown }
            : {};

          if (typeof args.device !== 'string' || !args.device.trim()) {
            return toolError('A device name or ID is required.');
          }

          const observation = await this.intelligence.readObservations(
            scope,
            args.device,
          );

          if (!observation) {
            return toolError(
              'No authorized Core observation is available for this device.',
            );
          }

          return toolResult(observation);
        },
      },
      {
        name: 'control_device',
        label: 'Control an approved device',
        description: 'Execute a supported on/off action through Energrid Core. Core checks site scope, approval, enrollment, configured control binding, identity, and readback.',
        parameters: {
          type: 'object',
          properties: {
            device: { type: 'string', description: 'Exact device ID or an unambiguous part of its friendly name.' },
            action: { type: 'string', enum: ['turn_on', 'turn_off'] },
          },
          required: ['device', 'action'],
          additionalProperties: false,
        },
        execute: async (_toolCallId, raw) => {
          const args = raw && typeof raw === 'object' ? raw as { device?: unknown; action?: unknown } : {};
          if (typeof args.device !== 'string' || !['turn_on', 'turn_off'].includes(String(args.action))) return toolError('Provide a device and either turn_on or turn_off.');
          const action = args.action as 'turn_on' | 'turn_off';
          const device = this.resolveDevice(scope, args.device);
          if (!device) return toolError('No unambiguous approved device matched that name.');
          try {
            const result = await this.controls.execute(device.id, action);
            const updated = this.registry.getDevices().find(item => item.id === device.id);
            return toolResult({ ...result, state: updated?.state.values, observedAt: updated?.state.observedAt });
          } catch (error) {
            return toolError(error instanceof Error ? error.message : 'Energrid Core rejected the action.');
          }
        },
      },
    ];
  }

  private resolveDevice(scope: HouseAgentScope, query: string) {
    const normalized = query.trim().toLocaleLowerCase();
    const approved = this.registry.getDevices().filter(device =>
      device.tenantId === scope.tenantId && device.siteId === scope.siteId &&
      device.trustStatus === 'approved' && device.kind === 'physical');
    const exact = approved.find(device => device.id.toLocaleLowerCase() === normalized);
    if (exact) return exact;
    const matches = approved.filter(device => device.displayName.toLocaleLowerCase().includes(normalized));
    return matches.length === 1 ? matches[0] : null;
  }
}

function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value };
}

function toolError(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function configuredFreshnessSeconds(): number {
  const value = Number(process.env.HOME_OBSERVATION_FRESHNESS_SECONDS || 60);
  return Number.isFinite(value) ? Math.min(86_400, Math.max(1, Math.floor(value))) : 60;
}
