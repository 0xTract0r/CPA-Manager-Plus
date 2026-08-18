import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AsyncPanel } from '@/components/ui/AsyncPanel';
import { useInterval } from '@/hooks/useInterval';
import {
  FARM_TELEMETRY_FINGERPRINT_FIELDS,
  resolveBeaconSourceKind,
  type FarmContainerBeaconView,
  type FarmContainerView,
  type FarmTelemetryFingerprintField,
} from '@/types/farm';
import { formatDateTimeUtc8, formatInUtc8 } from '@/utils/datetime';
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

// beacon 时间线默认只渲染最近 N 条，避免容器上报密集时一次性渲染成百上千行把
// ~640px 窄抽屉挤成字墙；超出部分靠「展开更多」按需加载，而不是虚拟滚动
// （量级通常在数百条内，一次性挂载全部 DOM 也可接受，这里只是收敛默认视图）。
const BEACON_TIMELINE_DEFAULT_LIMIT = 20;

// beacon 时间线单元格的紧凑时间戳格式：MM/DD HH:mm:ss（24 小时制），比
// formatDateTimeUtc8 的完整 dateStyle/timeStyle 短得多，适合固定宽度的网格列；
// 完整时间戳（含 UTC+8 标注）放进 title，悬浮可查。
const BEACON_TIMESTAMP_COMPACT_OPTIONS: Intl.DateTimeFormatOptions = {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
};

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

// 指纹自洽卡 on-wire 列的「逐字段派生值」：把原始 beacon 逐字段派生进自洽比对
// 这一步尚未接入，故恒返回 null——注意这跟「原始 on_wire beacon 是否已实时采集」
// 是两回事（后者已在下方时间线逐条呈现，见 resolveBeaconSourceKind 标注）。独立抽
// 成函数（而非渲染里直接写 null）是为了逐字段派生接入后只需替换这一处实现——撞红
// 判定、面板级横幅可见性、单元格渲染分支都无需改动。
function onWireFieldValue(_field: FarmTelemetryFingerprintField): string | null {
  return null;
}

/**
 * 每容器遥测面板（用户⑤「每容器遥测内容抓取」）：declared vs on-wire 两列
 * 指纹自洽卡 + beacon 时间线 + 通道分布 + 新鲜度。插在 <FarmContainerDetail>
 * 的「device_id 对齐」section 旁。
 *
 * **来源边界（贯穿整个 UI，逐条标注不笼统）**：beacon 时间线混合两类来源，按
 * 后端 source_kind 逐条标注——declared=容器自报/声明，on_wire=mitmproxy/ebpf 在
 * 容器出站链路真实抓取。即便 on_wire 行也只证明该容器确实发出过这些请求，**不构
 * 成跨账号反关联证明**，绝不对整列笼统 claim on-wire。
 *
 * 另一件独立的事：指纹自洽卡的「出站实测 (on-wire)」一列是把 beacon **逐字段派
 * 生**进自洽比对这一步，尚未接入，因此该列显示中性占位符，并由卡顶一条面板级横
 * 幅统一说明「逐字段派生待接入，但原始 on_wire beacon 已在时间线实时呈现」，绝不
 * 用 declared 值冒充实测填 on-wire 列。declared 与 on-wire 逐字段值不一致时才撞
 * 红——由于该列逐字段值目前恒为空，撞红逻辑已实现但休眠（永不误红），待逐字段派
 * 生接入后（届时横幅按「是否已有任意字段被派生」自动收起）自然生效。
 *
 * 取数走 useFarmContainerBeacons（GET .../beacons，裸数组、captured_at 降序）：
 * 失败态经 AsyncPanel 如实呈现，不吞不伪造；空容器（后端返回 []）在数据态内
 * 以内联空提示处理，而不是把整卡（含来源边界说明）替换成空态卡片——逐条来源
 * 标注与 on-wire 列口径说明在任何数据量下都必须可见。
 */
export function FarmTelemetryPanel({ container }: FarmTelemetryPanelProps) {
  const { t, i18n } = useTranslation();
  const containerId = container?.id ?? null;
  const { beacons, loading, error } = useFarmContainerBeacons(containerId);

  // render-purity：now 存进 state（惰性初始化 + 30s tick），render 只读稳定值。
  const [nowMs, setNowMs] = useState(() => Date.now());
  useInterval(() => setNowMs(Date.now()), STALE_CLOCK_TICK_MS);

  // beacon 时间线默认折叠到最近 N 条；切换容器时重置，避免上一个容器「已展开」
  // 的状态漏到下一个容器上（历史条数不同，沿用旧展开态没有意义）。这里按 React
  // 官方「渲染期间调整 state」模式实现（而非 useEffect 里同步 setState），
  // 靠比对上一次渲染的 containerId 判断是否需要重置，避免多触发一次 commit。
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [prevContainerId, setPrevContainerId] = useState(containerId);
  if (containerId !== prevContainerId) {
    setPrevContainerId(containerId);
    setTimelineExpanded(false);
  }

  const latestBeacon = beacons[0];
  const channelDistribution = useMemo(() => computeChannelDistribution(beacons), [beacons]);
  const visibleBeacons = timelineExpanded
    ? beacons
    : beacons.slice(0, BEACON_TIMELINE_DEFAULT_LIMIT);
  const hasMoreBeacons = beacons.length > BEACON_TIMELINE_DEFAULT_LIMIT;

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
        {t('farm.telemetry.section', { defaultValue: '遥测信标（自报 + on-wire，逐条标注来源）' })}
      </h3>

      {/* 来源边界：显眼免责声明，警示色轻底，防止被当成反关联实测证据。
          准确化（U2 复核）：下方时间线混合两类来源、逐条标注——declared 行是容器
          自报/声明，on-wire 行才是 mitmproxy/ebpf 在出站链路真实抓取，不能对整列
          笼统说「都是 on-wire」。另一件独立的事是「把 beacon 逐字段派生进指纹自洽
          卡 on-wire 列」尚未接入，与「原始 on_wire beacon 已实时采集」不是一回事。 */}
      {/* progressive disclosure：来源边界免责声明较长（多段），默认收起，只留一行
          警示摘要占位，operator 需要完整口径时点开；避免长段落落地即占遥测 tab 首屏。 */}
      <details className={styles.disclaimerDisclosure} data-testid="farm-telemetry-disclaimer">
        <summary className={styles.disclaimerSummary}>
          {t('farm.telemetry.disclaimerSummary', {
            defaultValue: '来源边界说明（点开）：信标混合自报 + on-wire，不构成跨账号反关联证明',
          })}
        </summary>
        <p className={styles.probeTokenBadge}>
          {t('farm.telemetry.disclaimer', {
            defaultValue:
              '下方是该容器的遥测信标列表，混合两类来源并逐条标注：「自报 (declared)」是容器声明/自报的内容，「on-wire」行才是 mitmproxy/ebpf 在容器出站链路真实抓取的数据。即便 on-wire 行也只证明该容器确实发出过这些请求，不构成跨账号反关联证明。另外，上方指纹自洽卡的「出站实测 (on-wire)」列是把信标逐字段派生、与自报值比对的独立步骤——这一步尚未接入才显示占位，与「原始 on-wire 信标是否已抓取」是两回事。',
          })}
        </p>
      </details>
      <span className={styles.scopeBadge} data-testid="farm-telemetry-scope">
        {t('farm.telemetry.scopeBadge', {
          defaultValue: '口径：信标含自报与 on-wire 两类·逐条标注来源，指纹逐字段派生待接入',
        })}
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

          {/* 面板级横幅：只说明本列（指纹自洽卡 on-wire 列）的「逐字段派生」尚未
              接入、列内占位；仅当没有任何字段被派生出 on-wire 值时展示，逐字段派生
              接入后自动收起。注意与时间线里标注为 on-wire 的行区分——那些是原始
              on_wire beacon，已实时采集，不是「尚未接入」。 */}
          {!onWireCaptured && (
            <p className={styles.onWireBanner} data-testid="farm-telemetry-onwire-banner">
              {t('farm.telemetry.onWireBanner', {
                defaultValue:
                  '指纹逐字段 on-wire 派生尚未接入，以下 on-wire 列暂为占位；这只是「把信标逐字段派生进自洽比对」这一步没做，原始 on-wire 信标已实时采集——见下方时间线中标注为 on-wire 的行。',
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

        {/* 遥测信标时间线：最近若干条上报（captured_at 降序），混合 declared /
            on-wire 两类来源，逐条在「通道」列下方标注（on-wire 行=mitmproxy/ebpf
            真实出站抓取，declared 行=容器自报），不对整列笼统 claim on-wire。逐字段
            派生进指纹自洽卡 on-wire 列是另一件尚未接入的独立事，见上方 disclaimer /
            onWireBanner。列表用对齐网格行（.eventGrid）：时间 | 通道+来源 | host/路
            径 | 大小，列头对齐、跨行竖向对齐；host/路径单行截断 + title 悬浮显全；
            默认只渲染最近 N 条，超出靠「展开更多」按需加载，避免容器上报密集时把
            窄抽屉挤成一堵乱字墙。 */}
        <div className={styles.chartCol}>
          <span className={styles.chartLabel}>
            {t('farm.telemetry.timeline', {
              defaultValue: '遥测信标时间线（自报 + on-wire，逐条标注来源，最新在前）',
            })}
          </span>
          {beacons.length === 0 ? (
            <p className={styles.hintText} data-testid="farm-telemetry-timeline-empty">
              {t('farm.telemetry.timelineEmpty', {
                defaultValue: '暂无 beacon（空是正常返回，代表该容器尚未上报或未装配采集）。',
              })}
            </p>
          ) : (
            <>
              <div className={`${styles.eventGrid} ${styles.eventListHeader}`}>
                <span className={styles.eventHeaderCell}>
                  {t('farm.telemetry.timelineColumnTime', { defaultValue: '时间' })}
                </span>
                <span className={styles.eventHeaderCell}>
                  {t('farm.telemetry.timelineColumnChannel', { defaultValue: '通道' })}
                </span>
                <span className={styles.eventHeaderCell}>
                  {t('farm.telemetry.timelineColumnHostPath', { defaultValue: 'host / 路径' })}
                </span>
                <span className={`${styles.eventHeaderCell} ${styles.eventSizeCell}`}>
                  {t('farm.telemetry.timelineColumnSize', { defaultValue: '大小' })}
                </span>
              </div>
              <ul className={styles.eventList} data-testid="farm-telemetry-timeline">
                {visibleBeacons.map((beacon, index) => {
                  const hostPath = `${beacon.host}${beacon.path}`;
                  const capturedAtCompact = formatInUtc8(
                    beacon.captured_at,
                    BEACON_TIMESTAMP_COMPACT_OPTIONS,
                    undefined,
                    '—'
                  );
                  const capturedAtFull = formatDateTimeUtc8(beacon.captured_at, i18n.language);
                  // 逐条按后端 source_kind 准确标注来源：on_wire=mitmproxy/ebpf 真实
                  // 出站抓取，declared=容器自报，不对整列笼统 claim on-wire（U2 复核）。
                  const sourceKind = resolveBeaconSourceKind(beacon);
                  const isOnWire = sourceKind === 'on_wire';
                  const rawSource = beacon.source || (isOnWire ? 'mitmproxy' : 'declared');
                  return (
                    <li
                      key={`${beacon.captured_at}-${index}`}
                      className={`${styles.eventGrid} ${styles.eventItem}`}
                      data-testid={`farm-telemetry-beacon-${index}`}
                      data-source-kind={sourceKind}
                    >
                      <span className={`${styles.mono} ${styles.eventTimeCell}`} title={capturedAtFull}>
                        {capturedAtCompact}
                      </span>
                      <span className={styles.eventChannelCell}>
                        <span className="status-badge muted">{beacon.channel || 'unknown'}</span>
                        <span
                          className={`${styles.eventSourceHint} ${
                            isOnWire ? styles.eventSourceOnWire : styles.eventSourceDeclared
                          }`}
                          data-testid={`farm-telemetry-beacon-source-${index}`}
                          data-source-kind={sourceKind}
                          title={
                            isOnWire
                              ? t('farm.telemetry.rowSourceOnWireFull', {
                                  defaultValue: 'on-wire：{{source}} 在容器出站链路真实抓取',
                                  source: rawSource,
                                })
                              : t('farm.telemetry.rowSourceDeclaredFull', {
                                  defaultValue: '自报：容器声明 / 自报（{{source}}），非出站抓取',
                                  source: rawSource,
                                })
                          }
                        >
                          {isOnWire
                            ? t('farm.telemetry.rowSourceOnWire', {
                                defaultValue: 'on-wire · {{source}}',
                                source: rawSource,
                              })
                            : t('farm.telemetry.rowSourceDeclared', {
                                defaultValue: '自报 · {{source}}',
                                source: rawSource,
                              })}
                        </span>
                      </span>
                      <span className={`${styles.mono} ${styles.eventHostCell}`} title={hostPath}>
                        {hostPath}
                      </span>
                      <span className={`${styles.hintText} ${styles.eventSizeCell}`}>
                        {formatFileSize(beacon.body_bytes)}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {hasMoreBeacons && (
                <div className={styles.timelineMeta}>
                  <span className={styles.hintText}>
                    {timelineExpanded
                      ? t('farm.telemetry.timelineShowingAll', {
                          defaultValue: '已展开全部 {{count}} 条',
                          count: beacons.length,
                        })
                      : t('farm.telemetry.timelineShowingRecent', {
                          defaultValue: '显示最近 {{limit}} 条 · 共 {{count}} 条',
                          limit: BEACON_TIMELINE_DEFAULT_LIMIT,
                          count: beacons.length,
                        })}
                  </span>
                  <button
                    type="button"
                    className={styles.timelineToggle}
                    data-testid="farm-telemetry-timeline-toggle"
                    onClick={() => setTimelineExpanded((prev) => !prev)}
                  >
                    {timelineExpanded
                      ? t('farm.telemetry.timelineCollapse', { defaultValue: '收起' })
                      : t('farm.telemetry.timelineExpand', { defaultValue: '展开更多' })}
                  </button>
                </div>
              )}
            </>
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
