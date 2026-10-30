/** 本地只读快照的冻结时间；生产域名永远忽略该参数。 */
export function getLocalSnapshotTime(): number | undefined {
  if (typeof window === 'undefined' || !['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname)) return undefined;
  const value = Number(new URLSearchParams(window.location.search).get('snapshot_at'));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 只有本地专用只读服务明确确认后，才允许预览自动建立本地会话。 */
export async function getLocalSnapshotAccess(): Promise<string | undefined> {
  if (getLocalSnapshotTime() === undefined) return undefined;
  const response = await fetch('/snapshot-manifest', {
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(3000),
  });
  if (!response.ok || response.headers.get('X-CPAMP-Snapshot') !== 'read-only') return undefined;
  const manifest = await response.json();
  if (manifest.preview_mode !== 'read-only' || manifest.to_ms !== getLocalSnapshotTime()) return undefined;
  // 这是脱敏预览的公开本地口令；不能接受生产或任意管理凭据。
  return manifest.preview_access === 'local-snapshot-preview' ? manifest.preview_access : undefined;
}
