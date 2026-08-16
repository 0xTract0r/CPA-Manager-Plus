import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AsyncPanel } from '@/components/ui/AsyncPanel';
import { useInterval } from '@/hooks/useInterval';
import {
  FARM_TELEMETRY_FINGERPRINT_FIELDS,
  type FarmContainerBeaconView,
  type FarmContainerView,
  type FarmTelemetryFingerprintField,
} from '@/types/farm';
import { formatDateTimeUtc8 } from '@/utils/datetime';
import { formatFileSize } from '@/utils/format';
import { useFarmContainerBeacons } from '../hooks/useFarmContainerBeacons';
// E3：改为自有 module.scss（不再借用 FarmContainerDetail.module.scss），见该
// 文件顶部注释——结构类取值与 FarmContainerDetail 对应同名类保持一致，纯样式
// 来源迁移，视觉不变；新增的自洽卡网格类 / on-wire 横幅类是本次重做新增。
import styles from './FarmTelemetryPanel.module.scss';

// 前端展示用遥测新鲜度门槛：仅作 UI 陈旧标记的启发式阈值，**不是**后端精确
// 定义的 telemetry_silence 判据。beacon 是自报上报、间隔本身不固定，这里取
// 30min 作为「明显偏旧」的保守提示线并显式标注为展示启发式，不冒充精确 SLA。
export const FARM_BEACON_STALE_THRESHOLD_MS = 30 * 60 * 1000;

// 陈旧判定用的「当前时刻」时钟节拍：React 19 render-purity 规则不允许在 render
// 期间直接读 Date.now()。对齐 FarmAccountsPanel 既有做法——用一个每 30s 刷新
// 的 state 时钟（对齐本模块轮询节拍），render 只读这个稳定值。
const STALE_CLOCK_TICK_MS = 30 * 1000;

interface FarmTelemetryPanelProps {
  container: FarmContainerView | null;
}

interface ChannelCount {
  channel: string;
  count: number;
}

// 按 channel 归并计数（channel 由后端 ClassifyChannel 自算，前端不重分类）。
function computeChannelDistribution(beacons: FarmContainerBeaconView[]): ChannelCount[] {
  const counts = new Map<string, number>();
  for (const beacon of beacons) {
    const channel = beacon.channel || 'unknown';
    counts.set(channel, (counts.get(channel) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([channel, count]) => ({ channel, count }))
    .sort((a, b) => b.count - a.count || a.channel.localeCompare(b.channel));
}

// 从最新一条 beacon（数组已按 captured_at 降序）取某个指纹字段的「自报」值。
function declaredFieldValue(
  latest: FarmContainerBeaconView | undefined,
  field: FarmTelemetryFingerprintField
): string {
  if (!latest) return '';
  return latest[field] ?? '';
}

// 出站实测（on-wire）取值：真实抓取管道尚未落地，因此这里恒定返回 null。
// 独立抽成函数（而非在渲染里直接写字面量 null）是为了在抓取管道接入后，只需
// 替换这一处实现——撞红判定、面板级横幅可见性、单元格渲染分支都无需改动。
function onWireFieldValue(_field: FarmTelemetryFingerprintField): string | null {
  return null;
}

/**
 * 每容器遥测面板（用户⑤「每容器遥测内容抓取」）：declared vs on-wire 两列
 * 指纹自洽卡 + beacon 时间线 + 通道分布 + 新鲜度。插在 <FarmContainerDetail>
 * 的「device_id 对齐」section 旁。
 *
 * **诚实边界（贯穿整个 UI）**：这些 beacon 是容器「自报 / 声明」内容
 * （source ∈ declared/self-report/unknown），只证明上报管道连通与容器声明了
 * 什么，**不构成反关联证明**。自洽卡的 on-wire 一列是「真实出站抓取」值，
 * 抓取管道尚未落地，因此 on-wire 列一律显示中性占位符。E3 起，这个「未接入」
 * 状态不再逐单元格重复标注「待抓取管道 · 尚未证明」灰底徽标（避免整表灰墙），
 * 改成自洽卡顶部一条面板级横幅统一说明，绝不用已有的 declared 值去填充
 * on-wire 列冒充实测。declared 与 on-wire 不一致时才撞红——由于 on-wire 目前
 * 恒为空，撞红逻辑已实现但处于休眠（永不误红），待真实抓取管道接入后（届时
 * 某些字段会有真实 on-wire 值、横幅按「是否已有任意字段被实测」自动收起）
 * 自然生效。
 *
 * 取数走 useFarmContainerBeacons（GET .../beacons，裸数组、captured_at 降序）：
 * 失败态经 AsyncPanel 如实呈现，不吞不伪造；空容器（后端返回 []）在数据态内
 * 以内联空提示处理，而不是把整卡（含 on-wire 边界说明）替换成空态卡片——
 * on-wire 待抓取的诚实标注在任何数据量下都必须可见。
 */
export function FarmTelemetryPanel({ container }: FarmTelemetryPanelProps) {
  const { t, i18n } = useTranslation();
  const containerId = container?.id ?? null;
  const { beacons, loading, error } = useFarmContainerBeacons(containerId);

  // render-purity：now 存进 state（惰性初始化 + 30s tick），render 只读稳定值。
  const [nowMs, setNowMs] = useState(() => Date.now());
  useInterval(() => setNowMs(Date.now()), STALE_CLOCK_TICK_MS);

  const latestBeacon = beacons[0];
  const channelDistribution = useMemo(() => computeChannelDistribution(beacons), [beacons]);

  const latestCapturedAt = latestBeacon?.captured_at;
  const stale = useMemo(() => {
    if (!latestCapturedAt) return false;
    const ms = new Date(latestCapturedAt).getTime();
    if (!Number.isFinite(ms)) return false;
    return nowMs - ms > FARM_BEACON_STALE_THRESHOLD_MS;
  }, [latestCapturedAt, nowMs]);

  // on-wire 采集管道是否已对任意指纹字段产生过实测值。onWireFieldValue 目前
  // 恒为 null，因此这里恒为 false、面板级横幅恒定可见；管道接入后自然收敛。
  const onWireCaptured = FARM_TELEMETRY_FINGERPRINT_FIELDS.some(
    (field) => onWireFieldValue(field) !== null
  );

  if (!container) return null;

  return (
    <section
      className={styles.section}
      data-testid="farm-telemetry-panel"
      data-container-id={container.id}
    >
      <h3 className={styles.sectionTitle}>
        {t('farm.telemetry.section', { defaultValue: '遥测内容（自报 beacon）' })}
      </h3>

      {/* 诚实边界：显眼免责声明，警示色轻底，防止被当成反关联实测证据。 */}
      <p className={styles.probeTokenBadge} data-testid="farm-telemetry-disclaimer">
        {t('farm.telemetry.disclaimer', {
          defaultValue:
            '自报 / 合成 beacon 只证明上报管道连通与容器声明了什么，不构成反关联证明；下方 on-wire（真实出站抓取）列尚未接入，标注为「待抓取管道」，不代表已抓到真实出站值。',
        })}
      </p>
      <span className={styles.scopeBadge} data-testid="farm-telemetry-scope">
        {t('farm.telemetry.scopeBadge', { defaultValue: '口径：自报 / 声明，非出站实测' })}
      </span>

      <AsyncPanel
        loading={loading}
        error={error}
        isEmpty={false}
        loadingLabel={t('common.loading')}
        loadingTestId="farm-telemetry-loading"
        errorTestId="farm-telemetry-error"
      >
        {/* 指纹自洽卡：declared（自报，现在能填）vs on-wire（待抓取，占位）。 */}
        <div className={styles.estimateBox} data-testid="farm-telemetry-consistency">
          <div className={`${styles.consistencyGrid} ${styles.consistencyHeaderRow}`}>
            <span className={styles.chartLabel}>
              {t('farm.telemetry.fieldColumn', { defaultValue: '指纹字段' })}
            </span>
            <span className={styles.chartLabel}>
              {t('farm.telemetry.declaredColumn', { defaultValue: '自报 (declared)' })}
            </span>
            <span className={styles.chartLabel}>
              {t('farm.telemetry.onWireColumn', { defaultValue: '出站实测 (on-wire)' })}
            </span>
          </div>

          {/* E3：面板级横幅——替代此前逐单元格「待抓取管道 · 尚未证明」灰墙。
              仅当没有任何字段被实测过 on-wire 值时展示；真正接入抓取管道、
              个别字段开始有 on-wire 真值后自动收起。 */}
          {!onWireCaptured && (
            <p className={styles.onWireBanner} data-testid="farm-telemetry-onwire-banner">
              {t('farm.telemetry.onWireBanner', {
                defaultValue:
                  'on-wire 出站抓取管道尚未接入，以下 on-wire 列均为占位 / 声明态，不代表已完成实测。',
              })}
            </p>
          )}

          {FARM_TELEMETRY_FINGERPRINT_FIELDS.map((field) => {
            const declared = declaredFieldValue(latestBeacon, field);
            // 撞红逻辑保留但休眠：只有 on-wire 有值且与 declared 不一致才置红。
            // onWireFieldValue 目前恒返回 null → 永不误红。
            const onWire = onWireFieldValue(field);
            const clash = onWire !== null && declared !== onWire;
            const declaredClassName = `${styles.mono} ${styles.consistencyValue}${
              clash ? ` ${styles.consistencyValueClash}` : ''
            }`;
            const onWirePending = onWire === null;
            const onWireClassName = onWirePending
              ? `${styles.mono} ${styles.onWirePlaceholder}`
              : declaredClassName;
            return (
              <div
                key={field}
                data-testid={`farm-telemetry-consistency-row-${field}`}
                data-field={field}
                data-clash={clash ? 'true' : 'false'}
                className={`${styles.consistencyGrid} ${styles.consistencyRow}`}
              >
                <span className={styles.mono}>
                  {t(`farm.telemetry.field_${field}`, { defaultValue: field })}
                </span>
                <span data-testid={`farm-telemetry-declared-${field}`} className={declaredClassName}>
                  {declared || '—'}
                </span>
                <span
                  data-testid={`farm-telemetry-onwire-${field}`}
                  data-pending={onWirePending ? 'true' : 'false'}
                  className={onWireClassName}
                >
                  {onWirePending ? '—' : onWire || '—'}
                </span>
              </div>
            );
          })}
        </div>

        {/* 新鲜度：最近一条 beacon 时间 + 陈旧启发式标记（展示用，非精确 SLA）。 */}
        <div
          className={styles.deviceIdRow}
          data-testid="farm-telemetry-freshness"
          data-stale={stale ? 'true' : 'false'}
        >
          <span className={styles.chartLabel}>
            {t('farm.telemetry.freshness', { defaultValue: '遥测新鲜度' })}
          </span>
          {latestCapturedAt ? (
            <>
              <span className={styles.mono}>
                {formatDateTimeUtc8(latestCapturedAt, i18n.language)}
              </span>
              <span className={`status-badge ${stale ? 'warning' : 'success'}`}>
                {stale
                  ? t('farm.telemetry.stale', { defaultValue: '偏旧' })
                  : t('farm.telemetry.fresh', { defaultValue: '较新' })}
              </span>
            </>
          ) : (
            <span className={styles.hintText} data-testid="farm-telemetry-freshness-empty">
              {t('farm.telemetry.noBeacons', { defaultValue: '窗口内暂无 beacon 上报。' })}
            </span>
          )}
        </div>

        {/* 通道分布：按后端自算 channel 归并计数。 */}
        <div className={styles.chartCol}>
          <span className={styles.chartLabel}>
            {t('farm.telemetry.channelDistribution', { defaultValue: '通道分布' })}
          </span>
          <div data-testid="farm-telemetry-channels" className={styles.channelList}>
            {channelDistribution.length === 0 ? (
              <span className={styles.hintText}>
                {t('farm.telemetry.noBeacons', { defaultValue: '窗口内暂无 beacon 上报。' })}
              </span>
            ) : (
              channelDistribution.map((entry) => (
                <span
                  key={entry.channel}
                  data-testid={`farm-telemetry-channel-${entry.channel}`}
                  className="status-badge muted"
                >
                  {entry.channel} · {entry.count}
                </span>
              ))
            )}
          </div>
        </div>

        {/* beacon 时间线：最近若干条自报上报（captured_at 降序）。 */}
        <div className={styles.chartCol}>
          <span className={styles.chartLabel}>
            {t('farm.telemetry.timeline', { defaultValue: 'beacon 时间线（自报，最新在前）' })}
          </span>
          {beacons.length === 0 ? (
            <p className={styles.hintText} data-testid="farm-telemetry-timeline-empty">
              {t('farm.telemetry.timelineEmpty', {
                defaultValue: '暂无 beacon（空是正常返回，代表该容器尚未上报或未装配采集）。',
              })}
            </p>
          ) : (
            <ul className={styles.eventList} data-testid="farm-telemetry-timeline">
              {beacons.map((beacon, index) => (
                <li
                  key={`${beacon.captured_at}-${index}`}
                  className={styles.eventItem}
                  data-testid={`farm-telemetry-beacon-${index}`}
                >
                  <span className={styles.mono}>
                    {formatDateTimeUtc8(beacon.captured_at, i18n.language)}
                  </span>
                  <span className="status-badge muted">{beacon.channel || 'unknown'}</span>
                  <span className={styles.mono} style={{ wordBreak: 'break-all' }}>
                    {beacon.host}
                    {beacon.path}
                  </span>
                  <span className={styles.hintText}>{formatFileSize(beacon.body_bytes)}</span>
                  <span className="status-badge muted">
                    {t(`farm.telemetry.source_${beacon.source}`, {
                      defaultValue: beacon.source || 'unknown',
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className={styles.hintText}>
          {t('farm.telemetry.deviceIdFullNote', {
            defaultValue:
              '此处 device_id 为自报全量值（非列表页脱敏前 16 位），仅供运维核对自洽性用；漂移/串号/host 泄漏等自洽异常经告警面板呈现。',
          })}
        </p>
      </AsyncPanel>
    </section>
  );
}
