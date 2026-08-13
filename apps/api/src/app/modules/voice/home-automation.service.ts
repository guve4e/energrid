import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  HomeContext,
  HomeIntentPlan,
  PlannedHomeAction,
} from '@energrid/domain-automation';
import { DeviceRegistryService } from '../devices/device-registry.service';
import { DeviceControlService } from '../devices/device-control.service';

const execFileAsync = promisify(execFile);

export interface HomeActionExecutionResult {
  action: PlannedHomeAction;
  status: 'success' | 'pending' | 'skipped' | 'failed';
  adapter: 'http' | 'mqtt' | 'simulated' | 'none';
  message: string;
  affected?: string[];
}

@Injectable()
export class HomeAutomationService {
  private readonly logger = new Logger(HomeAutomationService.name);

  constructor(
    private readonly deviceRegistry: DeviceRegistryService,
    private readonly deviceControl: DeviceControlService,
  ) {}

  async getHomeContext(): Promise<HomeContext> {
    const insideTempC = await this.getKitchenTemperature();

    return {
      outsideDark: process.env.HOME_FAKE_OUTSIDE_DARK !== 'false',
      insideTempC,
      targetTempC: numberFromEnv('HOME_FAKE_TARGET_TEMP_C', 21),
      comfortTempC: numberFromEnv('HOME_FAKE_COMFORT_TEMP_C', 22),
      homeMode: 'home',
      availableDevices: this.getAvailableDevices(),
      occupiedRooms: [],
      alarmArmed: process.env.HOME_FAKE_ALARM_ARMED === 'true',
    };
  }

  async executePlan(
    plan: HomeIntentPlan,
  ): Promise<HomeActionExecutionResult[]> {
    const results: HomeActionExecutionResult[] = [];

    for (const action of plan.actions) {
      results.push(await this.executeAction(action));
    }

    return results;
  }

  async getKitchenTemperature(): Promise<number | null> {
    const httpUrl = process.env.HOME_KITCHEN_TEMP_URL;

    if (httpUrl) {
      try {
        const response = await fetch(httpUrl, {
          signal: AbortSignal.timeout(
            numberFromEnv('HOME_DEVICE_READ_TIMEOUT_MS', 2500),
          ),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const body = await response.json();
        const value = readJsonPath(
          body,
          process.env.HOME_KITCHEN_TEMP_JSON_PATH || 'value',
        );
        const parsed = Number(value);

        if (Number.isFinite(parsed)) return parsed;
        throw new Error(`Temperature value is not numeric: ${String(value)}`);
      } catch (error) {
        this.logger.warn(
          `[HOME TEMP READ FAILED] url=${httpUrl} ${errorMessage(error)}`,
        );
      }
    }

    const mqttTopic = process.env.HOME_KITCHEN_TEMP_MQTT_TOPIC;
    if (mqttTopic) {
      const value = await this.readMqttTemperature(mqttTopic);
      if (value != null) return value;
    }

    const configured = numberFromEnv(
      'PORTAL_KITCHEN_TEMP_C',
      numberFromEnv('HOME_FAKE_INSIDE_TEMP_C', 22.4),
    );

    return Number.isFinite(configured) ? configured : null;
  }

  private getAvailableDevices(): string[] {
    const configured = process.env.HOME_AVAILABLE_DEVICES;
    if (configured) {
      return configured
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }

    return this.deviceRegistry.getAvailableDeviceIds();
  }

  private async executeAction(
    action: PlannedHomeAction,
  ): Promise<HomeActionExecutionResult> {
    if (action.type === 'status.report') {
      return {
        action,
        status: 'skipped',
        adapter: 'none',
        message: 'Status report does not require device execution.',
      };
    }

    if (action.type === 'light.turn_on') {
      return this.executeRegisteredDeviceAction(action, 'turn_on');
    }

    if (action.type === 'light.turn_off') {
      return this.executeRegisteredDeviceAction(action, 'turn_off');
    }

    return {
      action,
      status: 'skipped',
      adapter: 'none',
      message: `Unsupported action ${action.type}.`,
    };
  }

  private async executeRegisteredDeviceAction(
    action: PlannedHomeAction,
    deviceAction: 'turn_on' | 'turn_off',
  ): Promise<HomeActionExecutionResult> {
    if (!action.deviceId) {
      return {
        action,
        status: 'skipped',
        adapter: 'none',
        message: `No device selected for ${action.type}.`,
      };
    }

    const result = await this.deviceControl.execute(
      action.deviceId,
      deviceAction,
    );

    return {
      action,
      status: result.status,
      adapter: result.adapter,
      message: result.message,
      affected: result.affectedDeviceIds,
    };
  }

  private async readMqttTemperature(topic: string): Promise<number | null> {
    const args = [
      '-h',
      this.mqttHost(),
      '-p',
      this.mqttPort(),
      '-t',
      topic,
      '-C',
      '1',
      '-W',
      String(
        Math.ceil(numberFromEnv('HOME_DEVICE_READ_TIMEOUT_MS', 2500) / 1000),
      ),
    ];
    this.appendMqttCredentials(args);

    try {
      const result = await execFileAsync(this.mqttSubCommand(), args, {
        timeout: numberFromEnv('HOME_DEVICE_READ_TIMEOUT_MS', 2500) + 500,
      });
      const payload = String(result.stdout || '').trim();
      if (!payload) throw new Error('MQTT temperature payload is empty');

      const body = JSON.parse(payload);
      const value = readJsonPath(
        body,
        process.env.HOME_KITCHEN_TEMP_JSON_PATH || 'temperature',
      );
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;

      throw new Error(`Temperature value is not numeric: ${String(value)}`);
    } catch (error) {
      this.logger.warn(
        `[HOME TEMP MQTT READ FAILED] topic=${topic} ${errorMessage(error)}`,
      );
      return null;
    }
  }

  private appendMqttCredentials(args: string[]): void {
    if (process.env.HOME_MQTT_USERNAME) {
      args.push('-u', process.env.HOME_MQTT_USERNAME);
    }
    if (process.env.HOME_MQTT_PASSWORD) {
      args.push('-P', process.env.HOME_MQTT_PASSWORD);
    }
  }

  private mqttHost(): string {
    return process.env.HOME_MQTT_HOST || process.env.MQTT_HOST || 'localhost';
  }

  private mqttPort(): string {
    return process.env.HOME_MQTT_PORT || process.env.MQTT_PORT || '1883';
  }

  private mqttSubCommand(): string {
    return process.env.HOME_MQTT_SUB_BIN || 'mosquitto_sub';
  }
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function readJsonPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (current && typeof current === 'object' && part in current) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
