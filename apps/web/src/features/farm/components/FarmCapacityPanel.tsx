import { useTranslation } from 'react-i18next';
import { AsyncPanel } from '@/components/ui/AsyncPanel';
import { Button } from '@/components/ui/Button';
import { IconChartLine } from '@/components/ui/icons';
import { formatFileSize } from '@/utils/format';
import type { FarmAccountProvisioningView } from '@/types/farm';
import { useFarmCapacity } from '../hooks/useFarmCapacity';
import styles from './FarmCapacityPanel.module.scss';

type BadgeTone = 'success' | 'warning' | 'error' | 'muted';

// per-account 供给状态派生（机器码 → 展示语义），口径与后端
// accountProvisioningView 契约一一对应，前端不重推资格判定：
//   - auto_provisioned=true：已成功自动接入（success）。
//   - pending_reason=no_proxy：待住宅代理，fail-closed 未建容器（warning）。
//   - pending_reason=capacity_exhausted：容量已满，暂缓供给（error）。
//   - eligible=true 且无 pending：候选、排队等下一轮（muted，非异常）。
//   - 其余（eligible=false 且无 pending）：不适用（已绑/不合格，muted）。
function deriveProvisioningStatus(item: FarmAccountProvisioningView): {
  labelKey: string;
  tone: BadgeTone;
} {
  if (item.auto_provisioned) return { labelKey: 'statusProvisioned', tone: 'success' };
  if (item.pending_reason === 'no_proxy') return { labelKey: 'statusPendingNoProxy', tone: 'warning' };
  if (item.pending_reason === 'capacity_exhausted') {
    return { labelKey: 'statusPendingCapacity', tone: 'error' };
  }
  if (item.eligible) return { labelKey: 'statusEligible', tone: 'muted' };
  return { labelKey: 'statusIneligible', tone: 'muted' };
}

/**
 * 容量就绪度 + 「认证即自动供」状态面板（消费 GET /api/farm/capacity）。
 *
 * 用户 2026-08-04 决策：容器供给模型改为全自动「认证即自动供」（后端做成默认关、
 * 容量感知、fail-safe 的灰度 reconcile），农场页裸「新建容器」入口移除。本面板据此
 * 把「当前容量还能不能接新容器」与「哪些账号已自动接入 / 卡在无 proxy / 容量满」
 * 一屏摊开，取代旧的手动建容器叙事。
 *
 * 诚实边界：host_metrics_available=false 时不拿宿主内存字段当真实值展示，改标注
 * 「宿主指标不可用」；自动供给关闭时 provisioning 恒空，只展示关闭态说明，不把空
 * 列表误读成「无候选账号」。
 */
export function FarmCapacityPanel() {
  const { t } = useTranslation();
  const { capacity, loading, error, reload } = useFarmCapacity();

  const maxContainers = capacity?.max_active_containers ?? 0;
  const activeContainers = capacity?.active_containers ?? 0;
  const containersTone: BadgeTone =
    maxContainers > 0 && activeContainers >= maxContainers ? 'error' : 'success';
  const hostMetricsAvailable = Boolean(capacity?.host_metrics_available);
  const memAvailable = capacity?.mem_available_bytes ?? 0;
  const memThreshold = capacity?.mem_available_threshold_bytes ?? 0;
  const memTone: BadgeTone = !hostMetricsAvailable
    ? 'muted'
    : memAvailable > memThreshold
      ? 'success'
      : 'warning';
  const hasHeadroom = Boolean(capacity?.has_headroom);
  const autoProvisionEnabled = Boolean(capacity?.auto_provision_enabled);
  const provisioning = capacity?.provisioning ?? [];

  return (
    <section className={styles.panel} data-testid="farm-capacity-panel" aria-label={t('farm.capacity.title')}>
      <div className={styles.header}>
        <div className={styles.titleWrap}>
          <IconChartLine size={16} aria-hidden="true" />
          <h2 className={styles.title}>{t('farm.capacity.title')}</h2>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => reload()}
          data-testid="farm-capacity-refresh"
        >
          {t('common.refresh')}
        </Button>
      </div>

      <AsyncPanel
        loading={loading}
        error={error}
        loadingLabel={t('common.loading')}
        loadingTestId="farm-capacity-loading"
        errorTestId="farm-capacity-error"
      >
        <div className={styles.body}>
          {/* 容量就绪度：活跃/上限容器数、宿主可用内存 vs 阈值、总余量。 */}
          <div className={styles.readiness} data-testid="farm-capacity-readiness">
            <div className={styles.metric} data-testid="farm-capacity-active-containers">
              <span className={styles.metricLabel}>{t('farm.capacity.activeContainers')}</span>
              <span className={`status-badge ${containersTone} ${styles.metricValue}`}>
                {activeContainers}
                {' / '}
                {maxContainers > 0 ? maxContainers : t('farm.capacity.unlimited')}
              </span>
            </div>

            <div className={styles.metric} data-testid="farm-capacity-host-mem">
              <span className={styles.metricLabel}>{t('farm.capacity.hostMemory')}</span>
              {hostMetricsAvailable ? (
                <span className={`status-badge ${memTone} ${styles.metricValue}`}>
                  {formatFileSize(memAvailable)}
                  <span className={styles.metricSub}>
                    {' '}
                    ({t('farm.capacity.threshold')} {formatFileSize(memThreshold)})
                  </span>
                </span>
              ) : (
                <span className={`status-badge muted ${styles.metricValue}`}>
                  {t('farm.capacity.hostMemoryUnavailable')}
                </span>
              )}
            </div>

            <div className={styles.metric} data-testid="farm-capacity-headroom">
              <span className={styles.metricLabel}>{t('farm.capacity.headroomLabel')}</span>
              <span
                className={`status-badge ${hasHeadroom ? 'success' : 'warning'} ${styles.metricValue}`}
              >
                {hasHeadroom ? t('farm.capacity.headroom') : t('farm.capacity.noHeadroom')}
              </span>
            </div>
          </div>

          {/* 「认证即自动供」开关 + 说明。 */}
          <div className={styles.autoProvision}>
            <div className={styles.autoProvisionHead}>
              <span className={styles.autoProvisionTitle}>
                {t('farm.capacity.autoProvisionTitle')}
              </span>
              <span
                className={`status-badge ${autoProvisionEnabled ? 'success' : 'muted'}`}
                data-testid="farm-capacity-autoprovision-status"
              >
                {autoProvisionEnabled
                  ? t('farm.capacity.autoProvisionOn')
                  : t('farm.capacity.autoProvisionOff')}
              </span>
            </div>
            <p className={styles.autoProvisionHint}>
              {autoProvisionEnabled
                ? t('farm.capacity.autoProvisionOnHint')
                : t('farm.capacity.autoProvisionOffHint')}
            </p>
          </div>

          {/* per-account 供给状态：仅有条目时展开；关闭态由契约恒空，不误报。 */}
          {provisioning.length > 0 ? (
            <div className={styles.provisioning}>
              <span className={styles.provisioningTitle}>
                {t('farm.capacity.provisioningTitle')}
              </span>
              <ul className={styles.provisioningList} data-testid="farm-capacity-provisioning-list">
                {provisioning.map((item) => {
                  const status = deriveProvisioningStatus(item);
                  return (
                    <li
                      key={`${item.env}:${item.account_id}`}
                      className={styles.provisioningRow}
                      data-testid={`farm-capacity-provisioning-row-${item.account_id}`}
                    >
                      <span className={styles.provisioningAccount}>{item.account_id}</span>
                      <span className={styles.provisioningEnv}>
                        {t(`farm.env.${item.env}`, { defaultValue: item.env })}
                      </span>
                      <span
                        className={`status-badge ${status.tone} ${styles.provisioningStatus}`}
                        data-testid={`farm-capacity-provisioning-status-${item.account_id}`}
                      >
                        {t(`farm.capacity.${status.labelKey}`)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : autoProvisionEnabled ? (
            <p className={styles.provisioningEmpty} data-testid="farm-capacity-provisioning-empty">
              {t('farm.capacity.provisioningEmpty')}
            </p>
          ) : null}
        </div>
      </AsyncPanel>
    </section>
  );
}
