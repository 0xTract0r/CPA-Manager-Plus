import type { TFunction } from 'i18next';
import type { UsageCatchUpRunStatus } from '@/services/api/usageService';
import { formatInUtc8 } from '@/utils/datetime';
import type { MonitoringStatusTone } from './types';

export interface UsageCatchUpPresentation {
  /** 展示文案，如"自动补齐：上次 12:34:56 · 补 12 条 · 正常"。 */
  label: string;
  /** 用于 title 属性的完整说明，含触发来源和累计条数。 */
  title: string;
  tone: MonitoringStatusTone;
}

const toneByStatus = (status: string): MonitoringStatusTone => {
  switch (status) {
    case 'ok':
      return 'good';
    case 'error':
      return 'bad';
    case 'nodata':
    case 'skipped':
    default:
      return 'warn';
  }
};

/**
 * 8.6 用量自动补齐运行状态 -> 监控中心状态条展示文案。found=false（worker 还
 * 没跑完第一轮，或本地时区/时钟问题）时返回 null，调用方应不渲染该指示。
 */
export function presentUsageCatchUpStatus(
  found: boolean,
  status: UsageCatchUpRunStatus | null,
  locale: string,
  t: TFunction
): UsageCatchUpPresentation | null {
  if (!found || !status) return null;

  const lastRunLabel = status.lastRunAtMs
    ? formatInUtc8(
        status.lastRunAtMs,
        // #78 全站排查：走标准 timeStyle 路径统一成 24 小时 HH:mm:ss，
        // 不再用显式 hour/minute/second（那会经 locale 在 en-US 下渲染成 12 小时 AM/PM）。
        { timeStyle: 'medium' },
        locale
      )
    : '--';
  const statusLabel = t(`monitoring.usage_catchup_status_${status.lastStatus}`, {
    defaultValue: status.lastStatus,
  });
  const triggerLabel = t(`monitoring.usage_catchup_trigger_${status.trigger}`, {
    defaultValue: status.trigger,
  });

  const label = t('monitoring.usage_catchup_summary', {
    time: lastRunLabel,
    added: status.lastAdded,
    status: statusLabel,
    defaultValue: '自动补齐：上次 {{time}} · 补 {{added}} 条 · {{status}}',
  });

  const titleKey = status.lastError
    ? 'monitoring.usage_catchup_summary_title_with_error'
    : 'monitoring.usage_catchup_summary_title';
  const title = t(titleKey, {
    trigger: triggerLabel,
    total: status.totalAdded,
    error: status.lastError,
    defaultValue: status.lastError
      ? '触发方式：{{trigger}}；累计补齐 {{total}} 条；错误：{{error}}'
      : '触发方式：{{trigger}}；累计补齐 {{total}} 条',
  });

  return {
    label,
    title,
    tone: toneByStatus(status.lastStatus),
  };
}
