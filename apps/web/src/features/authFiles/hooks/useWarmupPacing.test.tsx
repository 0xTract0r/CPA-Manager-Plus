import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useLayoutEffect } from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthFileItem } from '@/types';
import fixtures from '@/features/demo/pacingFixtures.json';
import { useWarmupPacing } from './useWarmupPacing';
const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/services/api/authFiles', () => ({ authFilesApi: { getWarmupPacing: get } }));
let last: ReturnType<typeof useWarmupPacing>;
let view: ReactTestRenderer;
const target = () => structuredClone(fixtures.files[0]) as AuthFileItem;
function Probe({ file = target(), open = true }: { file?: AuthFileItem; open?: boolean }) {
  const result = useWarmupPacing(file, open);
  useLayoutEffect(() => {
    last = result;
  }, [result]);
  return null;
}
const response = (file = target(), eta = 20) => ({
  name: file.name,
  auth_index: file.auth_index,
  disabled: false,
  status: 'active',
  unavailable: false,
  account_scheduling: {
    ...file.account_scheduling,
    warmup_traffic_pacing: {
      ...file.account_scheduling!.warmup_traffic_pacing,
      observed_at: new Date().toISOString(),
      admission_balance_eta_seconds: eta,
    },
  },
});
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
  vi.stubGlobal('window', globalThis);
  const doc = new EventTarget();
  Object.defineProperty(doc, 'hidden', { value: false, writable: true, configurable: true });
  vi.stubGlobal('document', doc);
  get.mockReset();
  get.mockImplementation(async () => response());
});
afterEach(() => {
  if (view) act(() => view.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const mount = async (file = target()) => {
  await act(async () => {
    view = create(<Probe file={file} />);
  });
};
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
describe('visible narrow pacing polling', () => {
  it('fetches immediately and every 5 seconds; closes without polling', async () => {
    await mount();
    expect(get).toHaveBeenCalledTimes(1);
    await advance(5000);
    expect(get).toHaveBeenCalledTimes(2);
    await act(async () => view.update(<Probe open={false} />));
    await advance(10000);
    expect(get).toHaveBeenCalledTimes(2);
  });
  it('pauses in background and refreshes on foreground', async () => {
    await mount();
    await act(async () => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(10000);
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => {
      Object.defineProperty(document, 'hidden', { value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(get).toHaveBeenCalledTimes(2);
  });
  it('uses a monotonic countdown despite wall-clock rollback', async () => {
    await mount();
    expect(last.eta).toBe(20);
    vi.setSystemTime(Date.now() - 3600000);
    await advance(2000);
    expect(last.eta).toBe(18);
  });
  it('retains data on refresh failure and stops stale extrapolation', async () => {
    await mount();
    get.mockRejectedValue(new Error('offline'));
    await advance(15000);
    expect(last.failed).toBe(true);
    expect(last.stale).toBe(true);
    expect(last.eta).toBeNull();
    expect(last.file?.account_scheduling?.warmup_traffic_pacing?.request_balance).toBe(2.55);
  });
  it('never counts down for disabled or reauthorization accounts', async () => {
    get.mockResolvedValue({ ...response(), disabled: true });
    await mount();
    expect(last.eta).toBeNull();
  });
  it('rejects a mismatched response without choosing another same-name account', async () => {
    get.mockResolvedValue({ ...response(), auth_index: 'other' });
    await mount();
    expect(last.failed).toBe(true);
    expect(last.eta).toBeNull();
  });
});
