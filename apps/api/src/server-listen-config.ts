export function apiListenHost(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.HOST?.trim() || '0.0.0.0';
}
