import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, it, expect, vi } from 'vitest';
import { PerformancePanel } from './PerformancePanel';
import { demoPerformance } from './demoPerformance';
import type { PerformanceData } from './types';

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/hooks', () => ({ useTimezone: () => ({ timeZone: 'UTC' }) }));
vi.mock('@/components/charts/EChartsView', () => ({ EChartsView: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('legacy performance account filtering', () => {
  it('keeps accounts whose provider is omitted when selecting unknown', async () => {
    const data = demoPerformance([], { from_ms: 0, to_ms: 1000 });
    // 模拟后端 omitempty：供应商字段不存在，而非空字符串。
    data.accounts = [
      { ...data.summary, account_key: 'legacy-account' },
      { ...data.summary, account_key: 'current-account', provider: 'codex' },
    ] as PerformanceData['accounts'];
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<PerformancePanel data={data} onModel={() => {}} onRequests={() => {}} />);
    });
    try {
      const select = renderer.root
        .findAllByType('select')
        .find((node) => node.props['aria-label'] === 'performance.provider')!;
      expect(select.findAllByType('option').map((node) => node.props.value)).toEqual([
        'all',
        '',
        'codex',
      ]);
      await act(async () => {
        select.props.onChange({ target: { value: '' } });
      });
      const rows = renderer.root.findAllByType('tbody').slice(-1)[0].findAllByType('tr');
      expect(rows).toHaveLength(1);
      expect(rows[0].findByType('code').children).toEqual(['legacy-account']);
      await act(async () => {
        select.props.onChange({ target: { value: 'all' } });
      });
      expect(renderer.root.findAllByType('tbody').slice(-1)[0].findAllByType('tr')).toHaveLength(2);
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});
