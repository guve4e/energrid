import { AsyncLocalStorage } from 'node:async_hooks';
import { InteractionTraceSession } from './interaction-trace';

const storage = new AsyncLocalStorage<InteractionTraceSession>();

export function runWithInteractionTrace<T>(
  trace: InteractionTraceSession,
  operation: () => Promise<T>,
): Promise<T> {
  return storage.run(trace, operation);
}

export function currentInteractionTrace():
  InteractionTraceSession | undefined {
  return storage.getStore();
}
