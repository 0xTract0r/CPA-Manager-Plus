import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTimezone } from '@/hooks/useTimezone';
import { AsyncPanel } from '@/components/ui/AsyncPanel';
import { Button } from '@/components/ui/Button';
import { HealthPill, type HealthPillStatus } from '@/components/ui/HealthPill';
import { Select } from '@/components/ui/Select';
import { isFarmTelemetryAlertReason, type FarmAlertEntry } from '@/types/farm';
import { formatDateTimeUtc8 } from '@/utils/datetime';
import { useFarmAlerts } from '../hooks/useFarmAlerts';
import {
  normalizeFarmTelemetrySilenceState,
  telemetrySilenceStateToBadgeVariant,
} from '../utils/health';
import styles from './FarmAlertsPanel.module.scss';

const SEVERITY_TO_PILL: Record<FarmAlertEntry['severity'], HealthPillStatus> = {
  critical: 'err',
  warning: 'warn',
  info: 'idle',
};

type AlertStatusFilter = 'firing' | 'resolved' | 'all';

interface FarmAlertsPanelProps {
  mode?: 'summary' | 'full';
  onViewAll?: () => void;
}

/**
 * summary 固定消费 firing feed 且最多显示三条；full 保留既有
 * firing/resolved/all 筛选和全部动态 testid。后端顺序原样保留，前端不虚构严重度排序。
 */
export function FarmAlertsPanel({ mode = 'full', onViewAll }: FarmAlertsPanelProps) {
  const { t, i18n } = useTranslation();
  // 订阅全局时区（TZ2/#49）：切换时区时本组件重渲染，内部 formatDateTimeUtc8 同步刷新。
  useTimezone();
  const [statusFilter, setStatusFilter] = useState<AlertStatusFilter>('firing');
  const effectiveFilter = mode === 'summary' ? 'firing' : statusFilter;
  // firing 语义是"当前仍未解决"，不该按告警触发时间年龄过滤——否则会出现
  // 首屏 KPI（GET /api/farm/overview 的 active_alerts，同样不限年龄，见
  // dto.go ActiveAlerts 注释）显示 N 条，而本面板因硬编码 window=24h 把
  // >24h 前触发、至今仍未解决的告警过滤掉，两处数字对不上的矛盾（真实故障：
  // 容器 down 超 24h 未恢复，摘要/抽屉都显示"无告警"）。GET /api/farm/alerts
  // 不传 window 时后端语义是"不限时间窗，返回全部历史"（见
  // services/farm-orchestrator/internal/httpapi/observability.go
  // handleGetAlerts 顶部注释），配合 status=firing 即为"当前全部未解决"，
  // 与 KPI 计数口径一致。resolved 视图仍保留 window=24h，避免一次性拉出全部
  // 历史已解决告警。
  const alertsQuery =
    effectiveFilter === 'firing'
      ? { status: effectiveFilter }
      : { status: effectiveFilter, window: '24h' };
  const { alerts, loading, error } = useFarmAlerts(alertsQuery);
  const visibleAlerts = mode === 'summary' ? alerts.slice(0, 3) : alerts;

  const statusOptions: Array<{ value: AlertStatusFilter; label: string }> = [
    { value: 'firing', label: t('farm.alerts.filterFiring') },
    { value: 'resolved', label: t('farm.alerts.filterResolved') },
    { value: 'all', label: t('farm.filter.all') },
  ];

  return (
    <div
      className={`${styles.panel} ${mode === 'summary' ? styles.summary : ''}`}
      data-testid={mode === 'summary' ? 'farm-alert-summary' : 'farm-alerts-panel'}
    >
      <div className={styles.header}>
        <div className={styles.title}>{t('farm.alerts.title')}</div>
        {mode === 'full' ? (
          <div data-testid="farm-alerts-filter">
            <Select
              value={statusFilter}
              options={statusOptions}
              onChange={(value) => setStatusFilter(value as AlertStatusFilter)}
              ariaLabel={t('farm.alerts.filterLabel')}
              fullWidth={false}
              className={styles.filterSelect}
              id="farm-alerts-filter-control"
            />
          </div>
        ) : onViewAll ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onViewAll}
            aria-haspopup="dialog"
            data-testid="farm-alerts-view-all"
          >
            {t('farm.alerts.viewAll')}
          </Button>
        ) : null}
      </div>
      <p className={styles.desc}>
        {mode === 'summary' ? t('farm.alerts.summaryDesc') : t('farm.alerts.desc')}
      </p>

      <AsyncPanel
        loading={loading}
        error={error}
        isEmpty={visibleAlerts.length === 0}
        loadingLabel={t('common.loading')}
        loadingTestId="farm-alerts-loading"
        errorTestId="farm-alerts-error"
        empty={{
          title: t('farm.alerts.emptyTitle'),
          description: t('farm.alerts.emptyDesc'),
          testId: 'farm-alerts-empty',
        }}
      >
        <ul className={styles.list} data-testid="farm-alerts-list">
          {visibleAlerts.map((alert) => {
            const resolved = Boolean(alert.resolved_at);
            const pillStatus: HealthPillStatus = resolved ? 'idle' : SEVERITY_TO_PILL[alert.severity];
            const pillLabel = resolved
              ? t('farm.alerts.resolvedLabel')
              : t(`farm.alerts.severity_${alert.severity}`, { defaultValue: alert.severity });
            // telemetry_silence 告警的「遥测停摆四态」子类型（farm-egress-resilience
            // Change A）：后端把四态诊断写进 detail.silence_state（不新增独立 reason，
            // 保历史兼容，见 telemetry_silence.go）。据此把单一「遥测静默」细分为
            // 代理死 / 出站黑洞 / 进程死 / 正常无请求 / 待确认；缺失或非枚举值经
            // normalize 落到 indeterminate（待确认），绝不臆断。active 不产告警、
            // 兜底不渲染子标签。
            const rawSilenceState =
              alert.reason === 'telemetry_silence' && alert.detail
                ? alert.detail['silence_state']
                : undefined;
            const silenceStateSub =
              typeof rawSilenceState === 'string'
                ? normalizeFarmTelemetrySilenceState(rawSilenceState)
                : null;
            const showSilenceSub = silenceStateSub != null && silenceStateSub !== 'active';
            return (
              <li
                key={alert.id}
                className={styles.item}
                data-testid={
                  mode === 'summary'
                    ? `farm-alert-summary-item-${alert.id}`
                    : `farm-alert-item-${alert.id}`
                }
                data-alert-id={alert.id}
                data-resolved={resolved ? 'true' : 'false'}
              >
                <HealthPill
                  status={pillStatus}
                  label={pillLabel}
                  data-testid={`farm-alert-pill-${alert.id}`}
                />
                <div className={styles.itemBody}>
                  <div className={styles.itemHead}>
                    <span className={styles.containerId}>{alert.container_id}</span>
                    <span className={styles.reason}>
                      {/* 遥测自洽类告警（drift/collision/host_leak/entrypoint_
                          mismatch/silence）标一个中性「遥测」分类标签，与容器
                          运行态告警在同一 feed 里可区分；严重度仍由后端
                          eventView.severity 决定，前端不重推。 */}
                      {isFarmTelemetryAlertReason(alert.reason) ? (
                        <span
                          className="status-badge muted"
                          data-testid={`farm-alert-telemetry-tag-${alert.id}`}
                          style={{ marginRight: 6 }}
                        >
                          {t('farm.alerts.telemetryCategory', { defaultValue: '遥测' })}
                        </span>
                      ) : null}
                      {/* 遥测停摆四态子类型标签：把「遥测静默」细分为具体根因/结论
                          （代理死 / 出站黑洞 / 进程死 / 正常无请求 / 待确认），语义色
                          按四态派生（error=确证故障、warning=待确认、muted=正常无请求）。
                          诚实边界：待确认显式标出，不臆断「正常」。 */}
                      {showSilenceSub && silenceStateSub ? (
                        <span
                          className={`status-badge ${telemetrySilenceStateToBadgeVariant(silenceStateSub)}`}
                          data-testid={`farm-alert-silence-state-${alert.id}`}
                          data-silence-state={silenceStateSub}
                          style={{ marginRight: 6 }}
                          title={t(`farm.telemetry.silenceState.conclusion_${silenceStateSub}`, {
                            defaultValue: silenceStateSub,
                          })}
                        >
                          {t(`farm.telemetry.silenceState.label_${silenceStateSub}`, {
                            defaultValue: silenceStateSub,
                          })}
                        </span>
                      ) : null}
                      {t(`farm.healthReason.${alert.reason}`, { defaultValue: alert.reason })}
                    </span>
                  </div>
                  <div className={styles.itemMeta}>
                    <span>
                      {alert.from_status
                        ? `${t(`farm.status.${alert.from_status}`, { defaultValue: alert.from_status })} → `
                        : ''}
                      {t(`farm.status.${alert.to_status}`, { defaultValue: alert.to_status })}
                    </span>
                    <span className={styles.mono}>{formatDateTimeUtc8(alert.ts, i18n.language)}</span>
                    {resolved && alert.resolved_at ? (
                      <span className={styles.mono}>
                        {t('farm.alerts.resolvedAt')}{' '}
                        {formatDateTimeUtc8(alert.resolved_at, i18n.language)}
                      </span>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        {mode === 'summary' && alerts.length > 3 && onViewAll ? (
          <div className={styles.moreRow} data-testid="farm-alert-summary-overflow">
            <span>{t('farm.alerts.moreCount', { count: alerts.length - 3 })}</span>
            <Button variant="ghost" size="sm" onClick={onViewAll} aria-haspopup="dialog">
              {t('farm.alerts.viewAll')}
            </Button>
          </div>
        ) : null}
      </AsyncPanel>
    </div>
  );
}
