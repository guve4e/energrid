/** Bounded HTTP transport for third-party river pages (not a trusted data source). */
const RIVER_UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_RIVER_HTML_BYTES = 1024 * 1024;

export async function fetchRiverHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(RIVER_UPSTREAM_TIMEOUT_MS),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`River upstream HTTP ${response.status}`);

  const lengthHeader = response.headers.get('content-length');
  const declaredLength = lengthHeader === null ? NaN : Number(lengthHeader);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RIVER_HTML_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('River upstream response exceeded the size limit');
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('River upstream returned an empty response');
  const chunks: Buffer[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RIVER_HTML_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('River upstream response exceeded the size limit');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}
