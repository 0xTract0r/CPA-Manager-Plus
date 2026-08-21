import { useTranslation } from 'react-i18next';
import { AsyncPanel } from '@/components/ui/AsyncPanel';
import { Button } from '@/components/ui/Button';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { IconChartLine } from '@/components/ui/icons';
import { formatFileSize } from '@/utils/format';
import {
  buildSupplyFunnel,
  deriveAdmission,
  deriveAdmissionCta,
  deriveProvisioningStatus,
  deriveProxyCoverage,
  type FarmAdmissionCta,
  type FarmFunnelStage,
} from '../utils/capacity';
import type { StatusBadgeVariant } from '../utils/health';
import { useFarmCapacity } from '../hooks/useFarmCapacity';
import { useFarmAutoProvision } from '../hooks/useFarmAutoProvision';
import { useFarmAutoEnroll } from '../hooks/useFarmAutoEnroll';
import styles from './FarmCapacityPanel.module.scss';

// 供给漏斗四段 → i18n label key + testid slug（顺序对齐 buildSupplyFunnel 输出）。
const FUNNEL_STAGE_LABEL: Record<FarmFunnelStage, string> = {
  authenticated: 'funnelStageAuthenticated',
  has_proxy: 'funnelStageHasProxy',
  has_capacity: 'funnelStageHasCapacity',
  onboarded: 'funnelStageOnboarded',
};

// 可执行 CTA → 标题 / 说明 i18n key（按 pending_reason 语义）。none 不渲染。
const CTA_KEYS: Record<
  Exclude<FarmAdmissionCta, 'none'>,
  { title: string; hint: string }
> = {
  configure_proxy: { title: 'ctaConfigureProxyTitle', hint: 'ctaConfigureProxyHint' },
  expand_capacity: { title: 'ctaExpandCapacityTitle', hint: 'ctaExpandCapacityHint' },
  await_next_round: {
    title: 'ctaAwaitNextRoundTitle',
    hint: 'ctaAwaitNextRoundHint',
  },
};

/**
 * 容量准入 + 「认证即自动供」+ 供给漏斗面板（消费 GET /api/farm/capacity）。
 *
 * P2-D1 容量准入产品化：把「有没有余量」的布尔升级成「还能接入 N 个」（remaining_slots
 * + bottleneck 标注被哪条护栏封顶）、住宅代理覆盖率 M/N（proxy_coverage），并按聚合态
 * 给出单一可执行下一步 CTA（去配代理 / 扩容退役闲置 / 等下一轮自动接入）。
 *
 * P2-D2 供给漏斗可视化：认证 → 有代理 → 有容量 → 已接入 四段，一屏看清每个账号卡在
 * 哪一层（数据取自 provisioning[] 各账号 eligible/pending_reason/auto_provisioned，
 * 派生逻辑在 utils/capacity.ts，前端不重推资格判定）。
 *
 * 诚实边界：host_metrics_available=false 时不拿宿主内存字段当真实值；remaining_slots=null
 * 标注「容量未知」不伪造 0；proxy_coverage=null 标注「不可用」不谎称 0/0；自动供给关闭时
 * provisioning 恒空，只展示关闭态说明，不把空列表误读成「无候选账号」。
 */
export function FarmCapacityPanel() {
  const { t } = useTranslation();
  const { capacity, loading, error, reload } = useFarmCapacity();
  const autoProvisionEnabled = Boolean(capacity?.auto_provision_enabled);
  const { submitting: autoProvisionSubmitting, requestToggle: requestAutoProvisionToggle } =
    useFarmAutoProvision({ enabled: autoProvisionEnabled, reload });

  // 「全局自动纳管新号」开关（打 core /v0/management/farm-auto-enroll，与上面的
  // 自动供给刻意分开：自动供给管「已纳管账号是否自动建容器」，自动纳管管「新号是否
  // 进农场名单」）。自成一套读/写状态，不复用 capacity。
  const {
    enabled: autoEnrollEnabled,
    loading: autoEnrollLoading,
    submitting: autoEnrollSubmitting,
    requestToggle: requestAutoEnrollToggle,
  } = useFarmAutoEnroll();

  const maxContainers = capacity?.max_active_containers ?? 0;
  const activeContainers = capacity?.active_containers ?? 0;
  const containersTone: StatusBadgeVariant =
    maxContainers > 0 && activeContainers >= maxContainers ? 'error' : 'success';
  const hostMetricsAvailable = Boolean(capacity?.host_metrics_available);
  const memAvailable = capacity?.mem_available_bytes ?? 0;
  const memThreshold = capacity?.mem_available_threshold_bytes ?? 0;
  const memTone: StatusBadgeVariant = !hostMetricsAvailable
    ? 'muted'
    : memAvailable > memThreshold
      ? 'success'
      : 'warning';
  const provisioning = capacity?.provisioning ?? [];

  // D1/D2 派生：全部只读、口径对齐后端契约（见 utils/capacity.ts）。
  const admission = capacity
    ? deriveAdmission(capacity)
    : { remainingSlots: null as number | null, bottleneck: null, state: 'unknown' as const };
  const proxyCoverage = deriveProxyCoverage(capacity?.proxy_coverage);
  const funnel = buildSupplyFunnel(provisioning);
  const cta = deriveAdmissionCta({ funnel, admission, proxyCoverage });

  const admissionTone: StatusBadgeVariant =
    admission.state === 'available'
      ? 'success'
      : admission.state === 'exhausted'
        ? 'error'
        : 'muted';
  const bottleneckLabel = admission.bottleneck
    ? t(`farm.capacity.bottleneck_${admission.bottleneck}`)
    : '';

  const coverageTone: StatusBadgeVariant = !proxyCoverage
    ? 'muted'
    : proxyCoverage.uncovered > 0
      ? 'warning'
      : 'success';

  const ctaCount =
    cta.kind === 'configure_proxy'
      ? // uncovered 为 0 但有账号卡在代理段（如 proxy_url 瞬时取不到）时，?? 不会 fallthrough（0 是有效值），
        // 会错显 0；取两者最大值，保证 CTA 计数反映真实待处理账号数。
        Math.max(proxyCoverage?.uncovered ?? 0, funnel.blockedAtProxy)
      : cta.kind === 'expand_capacity'
        ? funnel.blockedAtCapacity
        : cta.kind === 'await_next_round'
          ? funnel.awaitingOnboard
          : 0;

  // 漏斗掉队 chip（只渲染 >0 的段），一屏看清账号卡在哪道闸门。
  const funnelDrops: { key: string; labelKey: string; count: number; tone: StatusBadgeVariant }[] =
    [
      {
        key: 'proxy',
        labelKey: 'funnelBlockedProxy',
        count: funnel.blockedAtProxy,
        tone: 'warning' as StatusBadgeVariant,
      },
      {
        key: 'capacity',
        labelKey: 'funnelBlockedCapacity',
        count: funnel.blockedAtCapacity,
        tone: 'error' as StatusBadgeVariant,
      },
      {
        key: 'onboard',
        labelKey: 'funnelAwaitOnboard',
        count: funnel.awaitingOnboard,
        tone: 'muted' as StatusBadgeVariant,
      },
    ].filter((d) => d.count > 0);

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
          {/* 容量准入：还能接入 N 个（+瓶颈）、代理覆盖 M/N、活跃/上限容器、宿主内存。 */}
          <div className={styles.readiness} data-testid="farm-capacity-readiness">
            <div className={styles.metric} data-testid="farm-capacity-remaining-slots">
              <span className={styles.metricLabel}>{t('farm.capacity.remainingSlotsLabel')}</span>
              <span
                className={`status-badge ${admissionTone} ${styles.metricValue}`}
                data-admission-state={admission.state}
              >
                {admission.state === 'available'
                  ? admission.remainingSlots
                  : admission.state === 'exhausted'
                    ? t('farm.capacity.remainingExhausted')
                    : t('farm.capacity.remainingUnknown')}
              </span>
              {bottleneckLabel ? (
                <span className={styles.metricNote}>{bottleneckLabel}</span>
              ) : null}
            </div>

            <div className={styles.metric} data-testid="farm-capacity-proxy-coverage">
              <span className={styles.metricLabel}>{t('farm.capacity.proxyCoverageLabel')}</span>
              {proxyCoverage ? (
                <>
                  <span className={`status-badge ${coverageTone} ${styles.metricValue}`}>
                    {proxyCoverage.configured}
                    {' / '}
                    {proxyCoverage.total}
                  </span>
                  {proxyCoverage.uncovered > 0 ? (
                    <span className={styles.metricNote}>
                      {t('farm.capacity.proxyCoverageUncovered', {
                        count: proxyCoverage.uncovered,
                      })}
                    </span>
                  ) : null}
                </>
              ) : (
                <span className={`status-badge muted ${styles.metricValue}`}>
                  {t('farm.capacity.proxyCoverageUnavailable')}
                </span>
              )}
            </div>

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
          </div>

          {/* 可执行 CTA：按聚合态给单一下一步（去配代理 / 扩容退役 / 等下一轮）。 */}
          {cta.kind !== 'none' ? (
            <div
              className={`${styles.cta} ${styles[`cta_${cta.tone}`]}`}
              data-testid="farm-capacity-cta"
              data-cta-kind={cta.kind}
              role="status"
            >
              <span className={styles.ctaTitle}>
                {t(`farm.capacity.${CTA_KEYS[cta.kind].title}`)}
              </span>
              <span className={styles.ctaHint}>
                {t(`farm.capacity.${CTA_KEYS[cta.kind].hint}`, { count: ctaCount })}
              </span>
            </div>
          ) : null}

          {/* 「认证即自动供」运行时开关 + 说明。拨动是行为变更，先二次确认再 PATCH
              /api/farm/config；成功后 reload() 让开关按后端真值翻转，失败保持原值 + toast。 */}
          <div className={styles.autoProvision}>
            <div className={styles.autoProvisionHead}>
              <span className={styles.autoProvisionTitle}>
                {t('farm.capacity.autoProvisionTitle')}
              </span>
              <span
                className={styles.autoProvisionControl}
                data-testid="farm-capacity-autoprovision-status"
                data-enabled={autoProvisionEnabled}
                data-submitting={autoProvisionSubmitting}
              >
                <ToggleSwitch
                  checked={autoProvisionEnabled}
                  onChange={requestAutoProvisionToggle}
                  disabled={loading || autoProvisionSubmitting}
                  ariaLabel={t('farm.capacity.autoProvisionToggleLabel')}
                  labelPosition="left"
                  label={
                    autoProvisionEnabled
                      ? t('farm.capacity.autoProvisionOn')
                      : t('farm.capacity.autoProvisionOff')
                  }
                />
              </span>
            </div>
            <p className={styles.autoProvisionHint}>
              {autoProvisionEnabled
                ? t('farm.capacity.autoProvisionOnHint')
                : t('farm.capacity.autoProvisionOffHint')}
            </p>
          </div>

          {/* 「全局自动纳管新号」开关（打 core，非编排器）。放在「自动供给」旁边，
              但语义刻意区分：自动供给=为已纳管账号自动建容器；自动纳管=新号是否进农场
              名单（per-account farm_enrolled 的全局默认）。拨动先二次确认再 PUT
              /v0/management/farm-auto-enroll；成功后按 core 真值翻转，失败保持原值 + toast。 */}
          <div className={styles.autoEnroll}>
            <div className={styles.autoEnrollHead}>
              <span className={styles.autoEnrollTitle}>
                {t('farm.capacity.autoEnrollTitle', { defaultValue: '自动纳管新号' })}
              </span>
              <span
                className={styles.autoEnrollControl}
                data-testid="farm-capacity-autoenroll-status"
                data-enabled={autoEnrollEnabled}
                data-submitting={autoEnrollSubmitting}
              >
                <ToggleSwitch
                  checked={autoEnrollEnabled}
                  onChange={requestAutoEnrollToggle}
                  disabled={autoEnrollLoading || autoEnrollSubmitting}
                  ariaLabel={t('farm.capacity.autoEnrollToggleLabel', {
                    defaultValue: '切换自动纳管新号',
                  })}
                  labelPosition="left"
                  label={
                    autoEnrollEnabled
                      ? t('farm.capacity.autoEnrollOn', { defaultValue: '自动' })
                      : t('farm.capacity.autoEnrollOff', { defaultValue: '手动' })
                  }
                />
              </span>
            </div>
            <p className={styles.autoEnrollHint}>
              {autoEnrollEnabled
                ? t('farm.capacity.autoEnrollOnHint', {
                    defaultValue:
                      '新认证的账号会自动进入农场纳管名单。（这不同于上面的「自动供给」——那是为已纳管账号自动建容器。）',
                  })
                : t('farm.capacity.autoEnrollOffHint', {
                    defaultValue:
                      '新号不会自动纳管，需在「账号设置」里为每个号手动开启「农场纳管」。（与上面的「自动供给」是两回事。）',
                  })}
            </p>
          </div>

          {/* D2 供给漏斗：认证→有代理→有容量→已接入 四段 + 各闸门掉队。仅有条目时展开。 */}
          {provisioning.length > 0 ? (
            <div className={styles.funnel} data-testid="farm-capacity-funnel">
              <span className={styles.funnelTitle}>{t('farm.capacity.funnelTitle')}</span>
              <ol className={styles.funnelStages} data-testid="farm-capacity-funnel-stages">
                {funnel.stages.map(({ stage, count }) => (
                  <li
                    key={stage}
                    className={styles.funnelStage}
                    data-testid={`farm-capacity-funnel-stage-${stage}`}
                    data-stage-count={count}
                  >
                    <span className={styles.funnelStageCount}>{count}</span>
                    <span className={styles.funnelStageLabel}>
                      {t(`farm.capacity.${FUNNEL_STAGE_LABEL[stage]}`)}
                    </span>
                  </li>
                ))}
              </ol>
              {funnelDrops.length > 0 || funnel.notApplicable > 0 ? (
                <div className={styles.funnelDrops} data-testid="farm-capacity-funnel-drops">
                  {funnelDrops.map((drop) => (
                    <span
                      key={drop.key}
                      className={`status-badge ${drop.tone} ${styles.funnelDrop}`}
                      data-testid={`farm-capacity-funnel-drop-${drop.key}`}
                    >
                      {t(`farm.capacity.${drop.labelKey}`, { count: drop.count })}
                    </span>
                  ))}
                  {funnel.notApplicable > 0 ? (
                    <span
                      className={`status-badge muted ${styles.funnelDrop}`}
                      data-testid="farm-capacity-funnel-not-applicable"
                    >
                      {t('farm.capacity.funnelNotApplicable', { count: funnel.notApplicable })}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

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
