/** Normalize a MAC address claim without upgrading its evidence provenance. */
export function normalizeMacAddress(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const octets = /^[0-9a-f]{12}$/i.test(trimmed)
    ? trimmed.match(/.{2}/g)
    : /^[0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5}$/i.test(trimmed)
      ? trimmed.split(':')
      : /^[0-9a-f]{1,2}(?:-[0-9a-f]{1,2}){5}$/i.test(trimmed)
        ? trimmed.split('-')
        : undefined;
  return octets?.map(octet => octet.padStart(2, '0').toLowerCase()).join(':');
}
