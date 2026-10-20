/**
 * LAN evidence is current for two minutes, matching the existing identity
 * probe limit. Discovery timestamps are captured at scan start, so age includes
 * scan duration and remains conservative when the completed scan is published.
 */
export const networkObservationFreshnessMs = 120_000;

export function isNetworkObservationFresh(
  observedAt: string,
  nowMs: number,
): boolean {
  const observedAtMs = Date.parse(observedAt);
  return Number.isFinite(observedAtMs) &&
    Number.isFinite(nowMs) &&
    observedAtMs <= nowMs &&
    nowMs - observedAtMs <= networkObservationFreshnessMs;
}
