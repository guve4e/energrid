import type { InteractionScope } from './interaction-trace';
import { currentInteractionTrace } from './interaction-trace-context';

/**
 * Instruments local agent tools while preserving their original
 * arguments, return values, and thrown errors.
 *
 * No tool arguments or results are stored in the trace.
 */
export function instrumentLocalTools<T>(
  scope: InteractionScope,
  tools: readonly T[],
): T[] {
  return tools.map(tool => {
    if (!tool || typeof tool !== 'object') {
      return tool;
    }

    const candidate = tool as {
      name?: unknown;
      execute?: unknown;
    };

    if (
      typeof candidate.name !== 'string' ||
      typeof candidate.execute !== 'function'
    ) {
      return tool;
    }

    const name = candidate.name;
    const originalExecute = candidate.execute as (
      ...args: unknown[]
    ) => unknown;

    return {
      ...(tool as object),
      execute: async (...args: unknown[]) => {
        const operation = async () =>
          originalExecute.apply(tool, args);

        const trace = currentInteractionTrace();

        if (!trace || !trace.matchesScope(scope)) {
          return operation();
        }

        return trace.measure(
          'assistant.tool',
          operation,
          name,
        );
      },
    } as T;
  });
}
