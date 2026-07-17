import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SummaryCardProps } from '@/features/monitoring/components/MonitoringShared';
import styles from '../MonitoringCenterPage.module.scss';
import { MonitoringSummarySection } from './MonitoringSummarySection';

const primaryCards: SummaryCardProps[] = [
  { label: 'Total calls', value: '1,234', meta: 'meta' },
  { label: 'Success rate', value: '99%', meta: 'meta' },
];
const secondaryCards: SummaryCardProps[] = [
  { label: 'Estimated Cost', value: '$1.23', meta: 'meta' },
];

describe('MonitoringSummarySection loading feedback', () => {
  it('renders cards directly with no overlay/skeleton markup when idle', () => {
    const html = renderToStaticMarkup(
      <MonitoringSummarySection primaryCards={primaryCards} secondaryCards={secondaryCards} />
    );

    expect(html).toContain('Total calls');
    expect(html).toContain('Estimated Cost');
    expect(html).not.toContain('更新中');
    expect(html).not.toContain(styles.skeleton ?? '__no_skeleton_class__');
  });

  it('dims stale cards and shows the updating overlay on refetch (updating=true)', () => {
    const html = renderToStaticMarkup(
      <MonitoringSummarySection
        primaryCards={primaryCards}
        secondaryCards={secondaryCards}
        updating
      />
    );

    // 旧卡片内容仍需保留在原位（变暗展示，不清空）。
    expect(html).toContain('Total calls');
    expect(html).toContain('Estimated Cost');
    // 叠加的「更新中」遮罩面板。
    expect(html).toContain('更新中');
    expect(html).toContain('role="status"');
  });

  it('renders skeleton placeholders instead of cards on first load with no snapshot yet', () => {
    const html = renderToStaticMarkup(
      <MonitoringSummarySection primaryCards={primaryCards} secondaryCards={secondaryCards} firstLoad />
    );

    // 首屏无数据：不应该把（可能是零值/占位）卡片渲染出来。
    expect(html).not.toContain('Total calls');
    expect(html).not.toContain('Estimated Cost');
    expect(html).not.toContain('更新中');
  });

  it('renders a fallback skeleton grid on first load even when no cards were built yet', () => {
    const html = renderToStaticMarkup(
      <MonitoringSummarySection primaryCards={[]} secondaryCards={[]} firstLoad />
    );

    expect(html).toContain(styles.summaryGrid);
  });

  it('firstLoad takes precedence over updating (both true should still show skeleton, not overlay)', () => {
    const html = renderToStaticMarkup(
      <MonitoringSummarySection
        primaryCards={primaryCards}
        secondaryCards={secondaryCards}
        updating
        firstLoad
      />
    );

    expect(html).not.toContain('Total calls');
    expect(html).not.toContain('更新中');
  });
});
