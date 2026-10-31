/** Canonical read-only projection for a Shelly switch status RPC response. */
export function parseShellySwitchStatus(
  value: unknown,
  componentKey: string,
): { output: boolean } | null {
  const match = /^switch:(0|[1-9]|[12][0-9]|3[01])$/.exec(componentKey)
  if (!match || !value || typeof value !== 'object' || Array.isArray(value)) return null
  const status = value as Record<string, unknown>
  return status.id === Number(match[1]) && typeof status.output === 'boolean'
    ? { output: status.output }
    : null
}
