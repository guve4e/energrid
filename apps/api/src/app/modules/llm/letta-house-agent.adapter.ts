import { DeviceIntelligenceQueryService } from '../devices/device-intelligence-query.service';
import { Injectable } from '@nestjs/common';
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
  private readonly client = new LettaAgentClient({ backend: 'local' });
  private readonly agentPromises = new Map<string, Promise<string>>();
  private readonly queues = new Map<string, Promise<HouseAgentReply>>();

  constructor(
    private readonly registry: DeviceRegistryService,
    private readonly controls: DeviceControlService,
    private readonly observations: ApprovedMqttObservationRuntime,
    private readonly intelligence: DeviceIntelligenceQueryService,
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
    const agentId = await this.agentFor(scope);

    // Only scoped Energrid observation and Core control tools are available.
    const session = this.client.resumeSession(agentId, {
      allowedTools: [
          'list_devices',
          'describe_device',
          'read_device_observation',
          'control_device',
        ],
      toolset: { base: 'none' },
      permissionMode: 'strict',
      skillSources: [],
      tools: this.deviceTools(scope),
      canUseTool: async (toolName) => (
        (
          toolName === 'list_devices' ||
          toolName === 'describe_device' ||
          toolName === 'read_device_observation'
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
        name: 'read_device_observation',
        label: 'Read an approved device observation',
        description: 'Read current values, source, timestamp, and freshness from Energrid Core for an approved and enrolled device. Never infer a value when no authorized observation is available.',
        parameters: {
          type: 'object',
          properties: { device: { type: 'string', description: 'Exact device ID or an unambiguous part of its friendly name.' } },
          required: ['device'],
          additionalProperties: false,
        },
        execute: async (_toolCallId, raw) => {
          const args = raw && typeof raw === 'object' ? raw as { device?: unknown } : {};
          if (typeof args.device !== 'string' || !args.device.trim()) return toolError('A device name or ID is required.');
          const device = this.resolveDevice(scope, args.device);
          if (!device) return toolError('No unambiguous approved device matched that name.');
          const state = await this.observations.getAuthorizedObservation(scope, device.id);
          if (!state) return toolError('No approved observation is available for this device.');
          const freshnessSeconds = configuredFreshnessSeconds();
          const fields = Object.fromEntries(Object.entries(state.fields).map(([field, item]) => {
            const deltaMs = Date.now() - Date.parse(item.receivedAt);
            const validTime = Number.isFinite(deltaMs) && deltaMs >= 0;
            const ageSeconds = validTime ? Math.floor(deltaMs / 1000) : null;
            return [field, {
              value: item.value,
              receivedAt: item.receivedAt,
              ...(item.measuredAt ? { measuredAt: item.measuredAt } : {}),
              sourceId: item.sourceId,
              ageSeconds,
              freshness: !validTime ? 'invalid' : ageSeconds! <= freshnessSeconds ? 'fresh' : 'stale',
            }];
          }));
          return toolResult({ deviceId: device.id, displayName: device.displayName, fields, freshnessLimitSeconds: freshnessSeconds });
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
