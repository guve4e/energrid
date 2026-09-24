export interface ExecutionDiagnosis {
  category:
    | 'success'
    | 'ack_missing'
    | 'mapping_mismatch'
    | 'verification_failed'
    | 'transport_failure'
    | 'device_offline'
    | 'unknown';

  stage:
    | 'command'
    | 'transport'
    | 'telemetry'
    | 'matching'
    | 'verification'
    | 'settling';

  confidence: number;

  summary: string;

  evidence: ExecutionEvidence[];

  suspects: ExecutionSuspect[];

  recommendations: ExecutionRecommendation[];
}

export interface ExecutionEvidence {
  label: string;
  value: string;
  status: 'success' | 'warning' | 'error';
}

export interface ExecutionSuspect {
  title: string;
  confidence: number;
  explanation: string;
}

export interface ExecutionRecommendation {
  id: string;
  label: string;
}
