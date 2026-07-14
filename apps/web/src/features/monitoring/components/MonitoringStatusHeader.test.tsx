import type { TFunction } from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import styles from '@/features/monitoring/MonitoringCenterPage.module.scss';
import type { UsageCatchUpPresentation } from '@/features/monitoring/model/usageCatchUpPresentation';
import { MonitoringStatusSummary } from './MonitoringStatusHeader';

const t = ((key: string) => key) as TFunction;

describe('MonitoringStatusSummary', () => {
  const baseProps = {
    connectionTone: 'good' as const,
    connectionLabel: 'Connected',
    lastRefreshedAt: null,
    locale: 'en-US',
    scopedFailureCount: 0,
    totalCalls: 100,
    t,
  };

  it('does not render the usage catch-up badge when status is null', () => {
    const markup = renderToStaticMarkup(
      <MonitoringStatusSummary {...baseProps} usageCatchUpStatus={null} />
    );
    expect(markup).not.toContain(styles.usageCatchUpToneGood);
    expect(markup).not.toContain(styles.usageCatchUpToneWarn);
    expect(markup).not.toContain(styles.usageCatchUpToneBad);
  });

  it('renders the usage catch-up badge with the ok/good tone class and label', () => {
    const status: UsageCatchUpPresentation = {
      label: '自动补齐：上次 12:34:56 · 补 12 条 · 正常',
      title: '触发方式：定时；累计补齐 4821 条',
      tone: 'good',
    };
    const markup = renderToStaticMarkup(
      <MonitoringStatusSummary {...baseProps} usageCatchUpStatus={status} />
    );
    expect(markup).toContain(styles.usageCatchUpToneGood);
    expect(markup).toContain('补 12 条');
    expect(markup).toContain('触发方式：定时');
  });

  it('renders the bad tone class for an error status', () => {
    const status: UsageCatchUpPresentation = {
      label: '自动补齐：上次 12:34:56 · 补 0 条 · 失败',
      title: '触发方式：定时；累计补齐 4821 条；错误：core unreachable',
      tone: 'bad',
    };
    const markup = renderToStaticMarkup(
      <MonitoringStatusSummary {...baseProps} usageCatchUpStatus={status} />
    );
    expect(markup).toContain(styles.usageCatchUpToneBad);
  });
});
