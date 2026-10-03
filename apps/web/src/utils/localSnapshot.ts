/** 本地只读快照的冻结时间；生产域名永远忽略该参数。 */
export function getLocalSnapshotTime(): number | undefined {
  if (typeof window === 'undefined' || !['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname)) return undefined;
  const value = Number(new URLSearchParams(window.location.search).get('snapshot_at'));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
