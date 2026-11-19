import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { DemoPacingControls } from './DemoPacingControls';

vi.mock('@/features/demo/demoFixtures', () => ({
  getPacingStoryState: () => ({
    account_file_name: 'local-simulation.json',
    paused: false,
    elapsed_seconds: 0,
    phase: 'reserved',
    completed: 0,
    total: 5,
    fast_forwarded_seconds: 0,
  }),
  controlPacingStory: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('refreshes through the latest committed callback without restarting timers', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('document', { hidden: false });
  const initialRefresh = vi.fn();
  const latestRefresh = vi.fn();
  let view!: ReactTestRenderer;
  act(() => {
    view = create(<DemoPacingControls onRefresh={initialRefresh} />);
  });
  expect(vi.getTimerCount()).toBe(2);
  act(() => view.update(<DemoPacingControls onRefresh={latestRefresh} />));
  expect(vi.getTimerCount()).toBe(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(initialRefresh).not.toHaveBeenCalled();
  expect(latestRefresh).toHaveBeenCalledTimes(1);
  act(() => view.unmount());
  expect(vi.getTimerCount()).toBe(0);
});
