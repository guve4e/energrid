export type PendingVoiceAction = {
  approvalId: string;
  expiresAt: number;
  actions: Array<{
    type: string;
    deviceId: string | null;
    room: string | null;
    value: string | number | null;
    risk: string;
  }>;
};
export type VoiceMetrics = {
  totalMs?: number | null;
  sttMs?: number | null;
  firstTextMs?: number | null;
  firstAudioMs?: number | null;
  assistantCompleteMs?: number | null;
  speechGatePassed?: boolean | null;
  audioRmsDb?: number | null;
  audioPeakDb?: number | null;
  llmFirstDeltaMs?: number | null;
  firstTtsDurationMs?: number | null;
  ttsTotalMs?: number | null;
  commandFastPath?: boolean | null;
  chunkCount?: number | null;
};

export type VoiceRunRecord = {
  id: string;
  completedAt: string;
  transcript: string;
  assistantReply: string;
  intent: string | null;
  plan?: {
    actions?: Array<{ type?: string; deviceId?: string; description?: string }>;
    requiresConfirmation?: boolean;
  } | null;
  executionResults?: Array<{
    status?: string;
    adapter?: string;
    message?: string;
  }>;
  metrics?: VoiceMetrics;
  runtime?: {
    sttProvider?: string;
    localWhisperModel?: string;
  };
  errors?: string[];
};
