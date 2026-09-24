import type { DeviceExecutionTrace } from '../device-registry.types';
import type { ExecutionDiagnosis } from './device-execution-diagnosis';

export class DeviceExecutionInvestigator {
  investigate(
    trace: Pick<DeviceExecutionTrace, 'outcome' | 'deviceId'>,
  ): ExecutionDiagnosis {
    switch (trace.outcome) {
      case 'running':
        return this.running(trace);

      case 'settled':
        return this.settled(trace);

      case 'timed_out':
        return this.timedOut(trace);

      case 'failed':
        return this.failed(trace);

      case 'drifted':
        return this.drifted(trace);

      case 'superseded':
        return this.superseded(trace);

      default:
        return this.unknown();
    }
  }

  private running(
    trace: Pick<DeviceExecutionTrace, 'deviceId'>,
  ): ExecutionDiagnosis {
    return {
      category: 'unknown',
      stage: 'settling',
      confidence: 1,
      summary: 'Execution is still in progress.',
      evidence: [
        {
          label: 'Device',
          value: trace.deviceId,
          status: 'warning',
        },
      ],
      suspects: [],
      recommendations: [],
    };
  }

  private settled(
    trace: Pick<DeviceExecutionTrace, 'deviceId'>,
  ): ExecutionDiagnosis {
    return {
      category: 'success',
      stage: 'settling',
      confidence: 1,
      summary: 'Execution completed successfully.',
      evidence: [
        {
          label: 'Device',
          value: trace.deviceId,
          status: 'success',
        },
      ],
      suspects: [],
      recommendations: [],
    };
  }

  private timedOut(
    trace: Pick<DeviceExecutionTrace, 'deviceId'>,
  ): ExecutionDiagnosis {
    return {
      category: 'ack_missing',
      stage: 'telemetry',
      confidence: 0.95,
      summary:
        'Command was published but no acknowledgement telemetry arrived before timeout.',
      evidence: [
        {
          label: 'Device',
          value: trace.deviceId,
          status: 'warning',
        },
      ],
      suspects: [
        {
          title: 'Missing telemetry acknowledgement',
          confidence: 0.95,
          explanation:
            'The command left Energrid successfully but matching telemetry never arrived.',
        },
      ],
      recommendations: [
        {
          id: 'inspect-mqtt',
          label: 'Inspect MQTT telemetry',
        },
        {
          id: 'inspect-device',
          label: 'Inspect device mapping',
        },
      ],
    };
  }

  private failed(
    trace: Pick<DeviceExecutionTrace, 'deviceId'>,
  ): ExecutionDiagnosis {
    return {
      category: 'transport_failure',
      stage: 'transport',
      confidence: 0.9,
      summary: 'Execution failed before successful reconciliation.',
      evidence: [
        {
          label: 'Device',
          value: trace.deviceId,
          status: 'error',
        },
      ],
      suspects: [],
      recommendations: [],
    };
  }

  private drifted(
    trace: Pick<DeviceExecutionTrace, 'deviceId'>,
  ): ExecutionDiagnosis {
    return {
      category: 'verification_failed',
      stage: 'verification',
      confidence: 0.9,
      summary:
        'The device initially matched the expected state but later drifted.',
      evidence: [
        {
          label: 'Device',
          value: trace.deviceId,
          status: 'warning',
        },
      ],
      suspects: [],
      recommendations: [],
    };
  }

  private superseded(
    trace: Pick<DeviceExecutionTrace, 'deviceId'>,
  ): ExecutionDiagnosis {
    return {
      category: 'unknown',
      stage: 'command',
      confidence: 1,
      summary:
        'This execution was replaced by a newer command before completion.',
      evidence: [
        {
          label: 'Device',
          value: trace.deviceId,
          status: 'warning',
        },
      ],
      suspects: [],
      recommendations: [],
    };
  }

  private unknown(): ExecutionDiagnosis {
    return {
      category: 'unknown',
      stage: 'verification',
      confidence: 0,
      summary: 'Unable to classify execution.',
      evidence: [],
      suspects: [],
      recommendations: [],
    };
  }
}
