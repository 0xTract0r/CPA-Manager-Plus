import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTimezone } from '@/hooks/useTimezone';
import { AsyncPanel } from '@/components/ui/AsyncPanel';
import { Drawer } from '@/components/ui/Drawer';
import {
  FARM_TELEMETRY_FINGERPRINT_FIELDS,
  pickLatestBeaconFieldValue,
  resolveBeaconSourceKind,
  type FarmContainerBeaconView,
  type FarmContainerView,
} from '@/types/farm';
import { formatDateTimeUtc8, formatInUtc8 } from '@/utils/datetime';
import { formatFileSize } from '@/utils/format';
import { useFarmContainerBeacons } from '../hooks/useFarmContainerBeacons';
import { maskTelemetryFingerprint } from '../utils/identity';
import { displayFingerprintValue, fingerprintFieldsClash } from '../utils/telemetry';
import styles from './FarmTelemetryPanel.module.scss';

// beacon 时间线默认只渲染最近 N 条，避免容器上报密集时一次性渲染成百上千行把
// ~640px 窄抽屉挤成字墙；超出部分靠「展开更多」按需加载。
const BEACON_TIMELINE_DEFAULT_LIMIT = 20;

// beacon 时间线单元格的紧凑时间戳格式：MM/DD HH:mm:ss（24 小时制），完整时间戳
// （含 UTC+8 标注）放进 title 悬浮可查。
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

/**
 * 每容器遥测面板（用户⑤「每容器遥测内容抓取」）：declared vs on-wire 两列指纹自洽卡
 * + beacon 时间线（可点开看完整上报内容）+ 通道分布 + 基于后端 telemetry_silence 的
 * 新鲜度/静默告警。插在 <FarmContainerDetail> 的「device_id 对齐」section 旁。
 *
 * **来源边界（贯穿整个 UI，逐条标注不笼统）**：beacon 时间线混合两类来源，按后端
 * source_kind 逐条标注——declared=容器自报/声明，on_wire=mitmproxy/ebpf 在容器出站链路
 * 真实抓取。即便 on_wire 行也只证明该容器确实发出过这些请求，**不构成跨账号反关联
 * 证明**。
 *
 * **本轮修复的横线根因**：指纹自洽卡此前对每列只读「该来源最近一条」beacon，而指纹
 * 字段分通道上报、最近那条常常不带某字段（如 datadog_logs 通道天然没有 device_id），
 * 于是整格误显横线「—」。现改为**逐字段各取该来源最近一条真正带值的 beacon**
 * （pickLatestBeaconFieldValue，纯函数 + 单测锁定），只有窗口内所有 beacon 都不带该
 * 字段时才回退占位。「自报 (declared)」列没有真值时不再显裸横线，而是诚实标注
 * 「未采集 / 不适用」并在 tooltip 说明 declared 未接入独立声明源、绝不编造值。
 *
 * 取数走 useFarmContainerBeacons（GET .../beacons，裸数组、captured_at 降序）：失败态
 * 经 AsyncPanel 如实呈现，不吞不伪造；空容器（后端返回 []）以内联空提示处理。
 */
export function FarmTelemetryPanel({ container }: FarmTelemetryPanelProps) {
  const { t, i18n } = useTranslation();
  // 订阅全局时区（TZ2/#49）：切换时区时本组件重渲染，内部 formatDateTimeUtc8 同步刷新。
  useTimezone();
  const containerId = container?.id ?? null;
  const { beacons, loading, error } = useFarmContainerBeacons(containerId);

  // 时间线折叠 + 详情抽屉选中项：切换容器时重置，避免上一个容器状态漏到下一个。
  // 按 React 官方「渲染期间调整 state」模式实现（比对上一次 containerId）。
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [selectedBeaconIndex, setSelectedBeaconIndex] = useState<number | null>(null);
  const [prevContainerId, setPrevContainerId] = useState(containerId);
  if (containerId !== prevContainerId) {
    setPrevContainerId(containerId);
    setTimelineExpanded(false);
    setSelectedBeaconIndex(null);
  }

  const latestBeacon = beacons[0];

  // 按 source_kind 分区（保持 captured_at 降序）：逐字段选值时各自取「该来源最近一条
  // 带该值」的 beacon，而不是整列绑定同一条 beacon（修横线的核心）。
  const declaredBeacons = useMemo(
    () => beacons.filter((b) => resolveBeaconSourceKind(b) === 'declared'),
    [beacons]
  );
  const onWireBeacons = useMemo(
    () => beacons.filter((b) => resolveBeaconSourceKind(b) === 'on_wire'),
    [beacons]
  );
  // 只要观测到任意一条 on_wire beacon 即为 true（与「具体哪些字段抽到了值」无关）。
  const onWireCaptured = onWireBeacons.length > 0;

  // 字段速览快照：优先最近一条 on-wire（真实出站抓取，最具权威），无则回退最近一条
  // （自报），下方按 source_kind 明确标注来源。
  const spreadBeacon = onWireBeacons[0] ?? latestBeacon;

  const channelDistribution = useMemo(() => computeChannelDistribution(beacons), [beacons]);
  const visibleBeacons = timelineExpanded
    ? beacons
    : beacons.slice(0, BEACON_TIMELINE_DEFAULT_LIMIT);
  const hasMoreBeacons = beacons.length > BEACON_TIMELINE_DEFAULT_LIMIT;

  const selectedBeacon =
    selectedBeaconIndex != null ? beacons[selectedBeaconIndex] : undefined;

  if (!container) return null;

  // 新鲜度/静默：一律以后端 telemetry_silence 为准（权威判据），不再用前端启发式时钟。
  // minutes_since_last === -1 是「从未观测」哨兵，绝不格式化成「-1 分钟前」。
  const silence = container.telemetry_silence;
  const neverObserved = silence ? silence.minutes_since_last < 0 : beacons.length === 0;
  const isStale = silence?.is_stale ?? false;
  const minutesSinceLast =
    silence && silence.minutes_since_last >= 0 ? Math.round(silence.minutes_since_last) : null;
  const latestCapturedAt = latestBeacon?.captured_at;

  return (
    <section
      className={styles.section}
      data-testid="farm-telemetry-panel"
      data-container-id={container.id}
    >
      <h3 className={styles.sectionTitle}>
        {t('farm.telemetry.section', { defaultValue: '遥测信标（自报 + on-wire，逐条标注来源）' })}
      </h3>

      {/* 来源边界免责声明：progressive disclosure，默认收起，只留一行警示摘要。 */}
      <details className={styles.disclaimerDisclosure} data-testid="farm-telemetry-disclaimer">
        <summary className={styles.disclaimerSummary}>
          {t('farm.telemetry.disclaimerSummary', {
            defaultValue: '来源边界说明（点开）：信标混合自报 + on-wire，不构成跨账号反关联证明',
          })}
        </summary>
        <p className={styles.probeTokenBadge}>
          {t('farm.telemetry.disclaimer', {
            defaultValue:
              '下方是该容器的遥测信标列表，混合两类来源并逐条标注：「自报 (declared)」是容器声明/自报的内容，「on-wire」行才是 mitmproxy/ebpf 在容器出站链路真实抓取的数据。即便 on-wire 行也只证明该容器确实发出过这些请求，不构成跨账号反关联证明。上方指纹自洽卡逐字段取「该来源最近一条带值的信标」比对；「自报」列没有真值时显「未采集/不适用」（不编造），「出站实测」列该容器暂无 on-wire 信标时显占位。',
          })}
        </p>
      </details>
      <span className={styles.scopeBadge} data-testid="farm-telemetry-scope">
        {t('farm.telemetry.scopeBadge', {
          defaultValue: '口径：信标含自报与 on-wire 两类·逐条标注来源，指纹逐字段选最近带值',
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
        {/* 指纹自洽卡：declared（自报）vs on-wire（出站实测），逐字段各取该来源最近一条
            带值的 beacon。 */}
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

          {/* on-wire 列占位横幅：该容器当前窗口内还没观测到任何 on_wire 信标时展示。 */}
          {!onWireCaptured && (
            <p className={styles.onWireBanner} data-testid="farm-telemetry-onwire-banner">
              {t('farm.telemetry.onWireBanner', {
                defaultValue:
                  '该容器当前窗口内暂未观测到 on-wire 信标（mitmproxy/ebpf 出站抓取），下方「出站实测」列暂为占位；逐字段派生已接入，一旦抓到任意 on-wire 信标即自动点亮并与自报值比对。',
              })}
            </p>
          )}

          {FARM_TELEMETRY_FINGERPRINT_FIELDS.map((field) => {
            // 逐字段选「该来源最近一条带值」的原始值：先用原始值判等/撞红，再各自脱敏
            // 展示（顺序不能反，见 utils/telemetry.ts 注释）。
            const declaredRaw = pickLatestBeaconFieldValue(declaredBeacons, field);
            const onWireRaw = onWireCaptured
              ? pickLatestBeaconFieldValue(onWireBeacons, field)
              : null;
            const onWirePending = onWireRaw === null;
            const clash = fingerprintFieldsClash(declaredRaw, onWireRaw);
            const declaredDisplay = displayFingerprintValue(field, declaredRaw);
            const onWireDisplay = onWirePending
              ? ''
              : displayFingerprintValue(field, onWireRaw ?? '');
            const declaredHasValue = declaredDisplay !== '';
            const clashClassName = clash ? ` ${styles.consistencyValueClash}` : '';
            const onWireClassName = onWirePending
              ? `${styles.mono} ${styles.onWirePlaceholder}`
              : `${styles.mono} ${styles.consistencyValue}${clashClassName}`;
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
                {declaredHasValue ? (
                  <span
                    data-testid={`farm-telemetry-declared-${field}`}
                    className={`${styles.mono} ${styles.consistencyValue}${clashClassName}`}
                  >
                    {declaredDisplay}
                  </span>
                ) : (
                  <span
                    data-testid={`farm-telemetry-declared-${field}`}
                    data-declared-empty="true"
                    className={styles.declaredNotCollected}
                    title={t('farm.telemetry.declaredNotCollectedHint', {
                      defaultValue:
                        '自报 (declared) 通道未接入该字段的独立声明源；此处不编造值。当前指纹以出站实测 (on-wire) 为准。',
                    })}
                  >
                    {t('farm.telemetry.declaredNotCollected', { defaultValue: '未采集 / 不适用' })}
                  </span>
                )}
                <span
                  data-testid={`farm-telemetry-onwire-${field}`}
                  data-pending={onWirePending ? 'true' : 'false'}
                  className={onWireClassName}
                >
                  {onWirePending ? '—' : onWireDisplay || '—'}
                </span>
              </div>
            );
          })}
        </div>

        {/* 字段速览：优先最近一条 on-wire 信标（真实出站抓取），无则回退自报。device_id/
            session_id 优先读后端已脱敏的 reported_fields，缺失才回退顶层并前端脱敏。 */}
        {spreadBeacon ? (
          (() => {
            const spreadKind = resolveBeaconSourceKind(spreadBeacon);
            const spreadIsOnWire = spreadKind === 'on_wire';
            const spreadRawSource =
              spreadBeacon.source || (spreadIsOnWire ? 'mitmproxy' : 'declared');
            const rf = spreadBeacon.reported_fields;
            const deviceId = rf?.device_id || maskTelemetryFingerprint(spreadBeacon.device_id);
            const sessionId = rf?.session_id ?? '';
            const apiBaseHost = rf?.api_base_url_host || spreadBeacon.api_base_url_host;
            const eventNames = spreadBeacon.event_names?.filter(Boolean) ?? [];
            return (
              <div className={styles.chartCol} data-testid="farm-telemetry-field-spread">
                <span className={styles.chartLabel}>
                  {t('farm.telemetry.fieldSpread', {
                    defaultValue: '最近一条信标字段速览（脱敏，逐字段来自服务端抽取）',
                  })}
                </span>
                <div className={styles.fieldSpreadGrid}>
                  <span className={styles.fieldSpreadLabel}>
                    {t('farm.telemetry.spreadSource', { defaultValue: '来源' })}
                  </span>
                  <span
                    className={`status-badge ${spreadIsOnWire ? 'success' : 'muted'} ${styles.fieldSpreadBadge}`}
                    data-testid="farm-telemetry-spread-source"
                    data-source-kind={spreadKind}
                  >
                    {spreadIsOnWire
                      ? t('farm.telemetry.rowSourceOnWire', {
                          defaultValue: 'on-wire · {{source}}',
                          source: spreadRawSource,
                        })
                      : t('farm.telemetry.rowSourceDeclared', {
                          defaultValue: '自报 · {{source}}',
                          source: spreadRawSource,
                        })}
                  </span>

                  <span className={styles.fieldSpreadLabel}>
                    {t('farm.telemetry.spreadCapturedAt', { defaultValue: '采集时间' })}
                  </span>
                  <span
                    className={styles.fieldSpreadValue}
                    data-testid="farm-telemetry-spread-captured-at"
                  >
                    {formatDateTimeUtc8(spreadBeacon.captured_at, i18n.language)}
                  </span>

                  <span className={styles.fieldSpreadLabel}>
                    {t('farm.telemetry.spreadChannel', { defaultValue: '通道' })}
                  </span>
                  <span
                    className={styles.fieldSpreadValue}
                    data-testid="farm-telemetry-spread-channel"
                  >
                    {spreadBeacon.channel || 'unknown'}
                  </span>

                  {deviceId ? (
                    <>
                      <span className={styles.fieldSpreadLabel}>
                        {t('farm.telemetry.field_device_id', { defaultValue: 'device_id' })}
                      </span>
                      <span
                        className={styles.fieldSpreadValue}
                        data-testid="farm-telemetry-spread-device-id"
                        title={t('farm.telemetry.maskedHint', {
                          defaultValue: '展示脱敏（前 12 + 后 4），完整值仅服务端保留',
                        })}
                      >
                        {deviceId}
                      </span>
                    </>
                  ) : null}

                  {sessionId ? (
                    <>
                      <span className={styles.fieldSpreadLabel}>
                        {t('farm.telemetry.field_session_id', { defaultValue: 'session_id' })}
                      </span>
                      <span
                        className={styles.fieldSpreadValue}
                        data-testid="farm-telemetry-spread-session-id"
                        title={t('farm.telemetry.maskedHint', {
                          defaultValue: '展示脱敏（前 12 + 后 4），完整值仅服务端保留',
                        })}
                      >
                        {sessionId}
                      </span>
                    </>
                  ) : null}

                  {apiBaseHost ? (
                    <>
                      <span className={styles.fieldSpreadLabel}>
                        {t('farm.telemetry.field_api_base_url_host', {
                          defaultValue: 'api_base_url_host',
                        })}
                      </span>
                      <span
                        className={styles.fieldSpreadValue}
                        data-testid="farm-telemetry-spread-api-base-host"
                      >
                        {apiBaseHost}
                      </span>
                    </>
                  ) : null}

                  {spreadBeacon.entrypoint ? (
                    <>
                      <span className={styles.fieldSpreadLabel}>
                        {t('farm.telemetry.field_entrypoint', { defaultValue: 'entrypoint' })}
                      </span>
                      <span
                        className={styles.fieldSpreadValue}
                        data-testid="farm-telemetry-spread-entrypoint"
                      >
                        {spreadBeacon.entrypoint}
                      </span>
                    </>
                  ) : null}

                  {rf?.sdk_version ? (
                    <>
                      <span className={styles.fieldSpreadLabel}>
                        {t('farm.telemetry.spreadSdkVersion', { defaultValue: 'SDK 版本' })}
                      </span>
                      <span
                        className={styles.fieldSpreadValue}
                        data-testid="farm-telemetry-spread-sdk-version"
                      >
                        {rf.sdk_version}
                      </span>
                    </>
                  ) : null}

                  {rf?.deployment_environment ? (
                    <>
                      <span className={styles.fieldSpreadLabel}>
                        {t('farm.telemetry.spreadDeploymentEnv', { defaultValue: '部署环境' })}
                      </span>
                      <span
                        className={styles.fieldSpreadValue}
                        data-testid="farm-telemetry-spread-deployment-env"
                      >
                        {rf.deployment_environment}
                      </span>
                    </>
                  ) : null}

                  {rf?.hostname ? (
                    <>
                      <span className={styles.fieldSpreadLabel}>
                        {t('farm.telemetry.spreadHostname', { defaultValue: 'hostname' })}
                      </span>
                      <span
                        className={styles.fieldSpreadValue}
                        data-testid="farm-telemetry-spread-hostname"
                      >
                        {rf.hostname}
                      </span>
                    </>
                  ) : null}

                  {eventNames.length > 0 ? (
                    <>
                      <span className={styles.fieldSpreadLabel}>
                        {t('farm.telemetry.spreadEventNames', { defaultValue: '事件名' })}
                      </span>
                      <span
                        className={styles.fieldSpreadValue}
                        data-testid="farm-telemetry-spread-event-names"
                      >
                        {eventNames.join('、')}
                      </span>
                    </>
                  ) : null}

                  <span className={styles.fieldSpreadLabel}>
                    {t('farm.telemetry.spreadHostPath', { defaultValue: 'host / 路径' })}
                  </span>
                  <span
                    className={styles.fieldSpreadValue}
                    data-testid="farm-telemetry-spread-host-path"
                    title={`${spreadBeacon.host}${spreadBeacon.path}`}
                  >
                    {`${spreadBeacon.host}${spreadBeacon.path}`}
                  </span>

                  <span className={styles.fieldSpreadLabel}>
                    {t('farm.telemetry.spreadBodyBytes', { defaultValue: '请求体大小' })}
                  </span>
                  <span
                    className={styles.fieldSpreadValue}
                    data-testid="farm-telemetry-spread-body-bytes"
                  >
                    {formatFileSize(spreadBeacon.body_bytes)}
                  </span>
                </div>
              </div>
            );
          })()
        ) : null}

        {/* 新鲜度 / 静默：以后端 telemetry_silence 为准。从未观测显「从未观测」（不是
            -1 分钟前）；is_stale 时浮出「遥测太旧」告警，带诚实 caveat。 */}
        <div
          className={styles.deviceIdRow}
          data-testid="farm-telemetry-freshness"
          data-stale={isStale ? 'true' : 'false'}
          data-never-observed={neverObserved ? 'true' : 'false'}
        >
          <span className={styles.chartLabel}>
            {t('farm.telemetry.freshness', { defaultValue: '遥测新鲜度' })}
          </span>
          {latestCapturedAt ? (
            <span className={styles.mono}>{formatDateTimeUtc8(latestCapturedAt, i18n.language)}</span>
          ) : null}
          {neverObserved ? (
            <span
              className="status-badge muted"
              data-testid="farm-telemetry-freshness-badge"
              title={t('farm.telemetry.neverObservedHint', {
                defaultValue: '该容器从未观测到任何 beacon 上报（没有基线可比），不代表异常。',
              })}
            >
              {t('farm.telemetry.neverObserved', { defaultValue: '从未观测' })}
            </span>
          ) : !silence ? (
            <span
              className="status-badge muted"
              data-testid="farm-telemetry-freshness-badge"
              title={t('farm.telemetry.freshnessUnknownHint', {
                defaultValue: '编排器未返回 telemetry_silence，无法判定新鲜度。',
              })}
            >
              {t('farm.telemetry.freshnessUnknown', { defaultValue: '新鲜度未知' })}
            </span>
          ) : (
            <>
              <span
                className={`status-badge ${isStale ? 'warning' : 'success'}`}
                data-testid="farm-telemetry-freshness-badge"
              >
                {isStale
                  ? t('farm.telemetry.stale', { defaultValue: '偏旧' })
                  : t('farm.telemetry.fresh', { defaultValue: '较新' })}
              </span>
              {minutesSinceLast != null ? (
                <span className={styles.hintText}>
                  {t('farm.telemetry.minutesSinceLast', {
                    defaultValue: '约 {{minutes}} 分钟前',
                    minutes: minutesSinceLast,
                  })}
                </span>
              ) : null}
            </>
          )}
        </div>
        {isStale && silence ? (
          <p className={styles.staleWarning} data-testid="farm-telemetry-stale-warning">
            {t('farm.telemetry.staleWarning', {
              defaultValue:
                '遥测太旧：最近一条上报距今约 {{minutes}} 分钟，已超过 {{threshold}} 分钟门槛，可能是容器进程退出/异常——但也可能只是这段时间没有产生请求。采集平面区分不了「没有请求」和「采集链路本身挂了」，请结合容器运行态 / 账号态一起判断，不要仅凭此单独下线容器。',
              minutes: minutesSinceLast ?? '—',
              threshold: Math.round(silence.threshold_minutes),
            })}
          </p>
        ) : null}

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

        {/* 遥测信标时间线：captured_at 降序，混合 declared / on-wire 两类，逐条标注来源。
            每行可点击→抽屉显示该条完整上报内容。内容列展示通道 + 事件名 + 关键上报字段，
            不再只有网址 + 大小。 */}
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
              <p className={styles.hintText} data-testid="farm-telemetry-timeline-hint">
                {t('farm.telemetry.timelineClickHint', {
                  defaultValue: '点击任意一条查看该信标的完整上报内容（脱敏）。',
                })}
              </p>
              <div className={`${styles.eventGrid} ${styles.eventListHeader}`}>
                <span className={styles.eventHeaderCell}>
                  {t('farm.telemetry.timelineColumnTime', { defaultValue: '时间' })}
                </span>
                <span className={styles.eventHeaderCell}>
                  {t('farm.telemetry.timelineColumnContent', { defaultValue: '内容' })}
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
                  const sourceKind = resolveBeaconSourceKind(beacon);
                  const isOnWire = sourceKind === 'on_wire';
                  const rawSource = beacon.source || (isOnWire ? 'mitmproxy' : 'declared');
                  const eventNames = beacon.event_names?.filter(Boolean) ?? [];
                  const rf = beacon.reported_fields;
                  // 关键上报字段（内容列速览）：优先脱敏后的 device_id，退 hostname/api host。
                  const keyReported =
                    rf?.device_id || rf?.hostname || rf?.api_base_url_host || '';
                  const hasProcessSignal = beacon.process_signal != null;
                  return (
                    <li
                      key={`${beacon.captured_at}-${index}`}
                      className={styles.eventItem}
                      data-testid={`farm-telemetry-beacon-${index}`}
                      data-source-kind={sourceKind}
                    >
                      <button
                        type="button"
                        className={`${styles.eventGrid} ${styles.eventRowButton}`}
                        data-testid={`farm-telemetry-beacon-open-${index}`}
                        onClick={() => setSelectedBeaconIndex(index)}
                        aria-label={t('farm.telemetry.beaconOpenAria', {
                          defaultValue: '查看 {{time}} 的信标详情',
                          time: capturedAtFull,
                        })}
                      >
                        <span
                          className={`${styles.mono} ${styles.eventTimeCell}`}
                          title={capturedAtFull}
                        >
                          {capturedAtCompact}
                        </span>
                        <span className={styles.eventContentCell}>
                          <span className={styles.eventContentTop}>
                            <span className="status-badge muted">
                              {beacon.channel || 'unknown'}
                            </span>
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
                            {hasProcessSignal ? (
                              <span
                                className="status-badge warning"
                                data-testid={`farm-telemetry-beacon-procsignal-${index}`}
                                title={t('farm.telemetry.rowProcessSignalHint', {
                                  defaultValue:
                                    '该信标携带进程退出信号（点开看详情）；不代表进程当前状态。',
                                })}
                              >
                                {t('farm.telemetry.rowProcessSignal', { defaultValue: '进程信号' })}
                              </span>
                            ) : null}
                          </span>
                          {eventNames.length > 0 ? (
                            <span
                              className={styles.eventContentMeta}
                              title={eventNames.join('、')}
                              data-testid={`farm-telemetry-beacon-events-${index}`}
                            >
                              {t('farm.telemetry.rowEventNames', {
                                defaultValue: '事件：{{names}}',
                                names: eventNames.join('、'),
                              })}
                            </span>
                          ) : null}
                          {keyReported ? (
                            <span
                              className={`${styles.mono} ${styles.eventContentMeta}`}
                              title={keyReported}
                            >
                              {t('farm.telemetry.rowKeyField', {
                                defaultValue: 'id：{{value}}',
                                value: keyReported,
                              })}
                            </span>
                          ) : null}
                        </span>
                        <span className={`${styles.mono} ${styles.eventHostCell}`} title={hostPath}>
                          {hostPath}
                        </span>
                        <span className={`${styles.hintText} ${styles.eventSizeCell}`}>
                          {formatFileSize(beacon.body_bytes)}
                        </span>
                      </button>
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
              '此处 device_id / session_id 展示均脱敏（前 12 + 后 4），完整值仅服务端保留、不经该只读接口回吐前端；判等/撞红在服务端与前端均以原始值为准，脱敏只作展示。漂移/串号/host 泄漏等自洽异常经告警面板呈现。',
          })}
        </p>
      </AsyncPanel>

      {/* 信标详情抽屉：时间线某条被点击时打开，展示该条完整上报内容（脱敏）。 */}
      <Drawer
        open={selectedBeacon != null}
        onClose={() => setSelectedBeaconIndex(null)}
        width={520}
        title={t('farm.telemetry.beaconDrawerTitle', { defaultValue: '信标上报详情（脱敏）' })}
      >
        {selectedBeacon ? <BeaconDetailBody beacon={selectedBeacon} /> : null}
      </Drawer>
    </section>
  );
}

/**
 * 信标详情抽屉正文：展示单条 beacon 的完整上报内容——概要 + reported_fields（脱敏）+
 * 事件名 + body_preview（脱敏预览）+ process_signal（进程退出信号，null 时诚实标注
 * 无信号且不代表进程还活着）。只展示脱敏值，不解析原始 body，不编造缺失字段。
 */
function BeaconDetailBody({ beacon }: { beacon: FarmContainerBeaconView }) {
  const { t, i18n } = useTranslation();
  useTimezone();

  const sourceKind = resolveBeaconSourceKind(beacon);
  const isOnWire = sourceKind === 'on_wire';
  const rawSource = beacon.source || (isOnWire ? 'mitmproxy' : 'declared');
  const rf = beacon.reported_fields;
  const eventNames = beacon.event_names?.filter(Boolean) ?? [];
  const ps = beacon.process_signal;
  const bodyPreview = beacon.body_preview ?? '';

  // reported_fields 逐字段渲染：缺失显 '—'（诚实，代表这条 beacon 没带该字段）。
  const reportedRows: Array<{ key: string; label: string; value: string; masked?: boolean }> = [
    { key: 'device_id', label: t('farm.telemetry.field_device_id', { defaultValue: 'device_id' }), value: rf?.device_id ?? '', masked: true },
    { key: 'session_id', label: t('farm.telemetry.field_session_id', { defaultValue: 'session_id' }), value: rf?.session_id ?? '', masked: true },
    { key: 'api_base_url_host', label: t('farm.telemetry.field_api_base_url_host', { defaultValue: 'api_base_url_host' }), value: rf?.api_base_url_host ?? '' },
    { key: 'deployment_environment', label: t('farm.telemetry.spreadDeploymentEnv', { defaultValue: '部署环境' }), value: rf?.deployment_environment ?? '' },
    { key: 'sdk_version', label: t('farm.telemetry.spreadSdkVersion', { defaultValue: 'SDK 版本' }), value: rf?.sdk_version ?? '' },
    { key: 'hostname', label: t('farm.telemetry.spreadHostname', { defaultValue: 'hostname' }), value: rf?.hostname ?? '' },
    { key: 'channel', label: t('farm.telemetry.spreadChannel', { defaultValue: '通道' }), value: rf?.channel ?? '' },
  ];

  return (
    <div className={styles.drawerBody} data-testid="farm-telemetry-beacon-drawer">
      {/* 概要 */}
      <div className={styles.drawerSection}>
        <div className={styles.fieldSpreadGrid}>
          <span className={styles.fieldSpreadLabel}>
            {t('farm.telemetry.spreadSource', { defaultValue: '来源' })}
          </span>
          <span
            className={`status-badge ${isOnWire ? 'success' : 'muted'} ${styles.fieldSpreadBadge}`}
            data-source-kind={sourceKind}
          >
            {isOnWire
              ? t('farm.telemetry.rowSourceOnWire', { defaultValue: 'on-wire · {{source}}', source: rawSource })
              : t('farm.telemetry.rowSourceDeclared', { defaultValue: '自报 · {{source}}', source: rawSource })}
          </span>

          <span className={styles.fieldSpreadLabel}>
            {t('farm.telemetry.spreadCapturedAt', { defaultValue: '采集时间' })}
          </span>
          <span className={styles.fieldSpreadValue}>
            {formatDateTimeUtc8(beacon.captured_at, i18n.language)}
          </span>

          <span className={styles.fieldSpreadLabel}>
            {t('farm.telemetry.spreadHostPath', { defaultValue: 'host / 路径' })}
          </span>
          <span className={styles.fieldSpreadValue}>{`${beacon.host}${beacon.path}`}</span>

          <span className={styles.fieldSpreadLabel}>
            {t('farm.telemetry.spreadBodyBytes', { defaultValue: '请求体大小' })}
          </span>
          <span className={styles.fieldSpreadValue}>{formatFileSize(beacon.body_bytes)}</span>
        </div>
      </div>

      {/* reported_fields（脱敏） */}
      <div className={styles.drawerSection}>
        <span className={styles.drawerSectionTitle}>
          {t('farm.telemetry.drawerReportedFields', { defaultValue: '上报字段（reported_fields，脱敏）' })}
        </span>
        <div className={styles.fieldSpreadGrid} data-testid="farm-telemetry-drawer-reported">
          {reportedRows.map((row) => (
            <FragmentRow key={row.key} label={row.label} value={row.value} masked={row.masked} />
          ))}
        </div>
      </div>

      {/* 事件名 */}
      <div className={styles.drawerSection}>
        <span className={styles.drawerSectionTitle}>
          {t('farm.telemetry.drawerEventNames', { defaultValue: '事件名（event_names）' })}
        </span>
        {eventNames.length > 0 ? (
          <div className={styles.eventNameChips} data-testid="farm-telemetry-drawer-events">
            {eventNames.map((name, i) => (
              <span key={`${name}-${i}`} className="status-badge muted">
                {name}
              </span>
            ))}
          </div>
        ) : (
          <span className={styles.hintText}>
            {t('farm.telemetry.drawerNoEventNames', {
              defaultValue: '该信标无事件名（仅 event_logging / datadog_logs 通道会带）。',
            })}
          </span>
        )}
      </div>

      {/* body_preview（脱敏预览） */}
      <div className={styles.drawerSection}>
        <span className={styles.drawerSectionTitle}>
          {t('farm.telemetry.drawerBodyPreview', { defaultValue: '请求体预览（脱敏，≤2048 字符）' })}
        </span>
        {bodyPreview ? (
          <pre className={styles.bodyPreview} data-testid="farm-telemetry-drawer-body-preview">
            {bodyPreview}
          </pre>
        ) : (
          <span className={styles.hintText}>
            {t('farm.telemetry.drawerNoBodyPreview', {
              defaultValue: '无请求体预览（该信标未携带可展示的 body，或编排器未提供该字段）。',
            })}
          </span>
        )}
      </div>

      {/* process_signal（进程退出信号） */}
      <div className={styles.drawerSection}>
        <span className={styles.drawerSectionTitle}>
          {t('farm.telemetry.drawerProcessSignal', { defaultValue: '进程退出信号（process_signal）' })}
        </span>
        {ps ? (
          <div className={styles.fieldSpreadGrid} data-testid="farm-telemetry-drawer-process-signal">
            <span className={styles.fieldSpreadLabel}>
              {t('farm.telemetry.psTerminated', { defaultValue: '已终止' })}
            </span>
            <span className={styles.fieldSpreadValue}>
              {ps.terminated
                ? t('common.yes', { defaultValue: '是' })
                : t('common.no', { defaultValue: '否' })}
            </span>

            <span className={styles.fieldSpreadLabel}>
              {t('farm.telemetry.psExitCode', { defaultValue: '退出码' })}
            </span>
            <span className={styles.fieldSpreadValue}>
              {ps.last_exit_code != null
                ? String(ps.last_exit_code)
                : t('farm.telemetry.psExitCodeNone', { defaultValue: '无（信号未带退出码）' })}
            </span>

            {ps.run_phase ? (
              <>
                <span className={styles.fieldSpreadLabel}>
                  {t('farm.telemetry.psRunPhase', { defaultValue: '运行阶段' })}
                </span>
                <span className={styles.fieldSpreadValue}>{ps.run_phase}</span>
              </>
            ) : null}

            <span className={styles.fieldSpreadLabel}>
              {t('farm.telemetry.psSignalSource', { defaultValue: '信号来源' })}
            </span>
            <span className={styles.fieldSpreadValue}>{ps.source || '—'}</span>

            <span className={styles.fieldSpreadLabel}>
              {t('farm.telemetry.psObservedAt', { defaultValue: '观测时间' })}
            </span>
            <span className={styles.fieldSpreadValue}>
              {ps.observed_at ? formatDateTimeUtc8(ps.observed_at, i18n.language) : '—'}
            </span>

            <span className={styles.drawerCaveat} data-caveat="true">
              {t('farm.telemetry.psCaveat', {
                defaultValue:
                  '这是遥测最后一次观测到的信号，不是编排器实时进程探测；不代表容器进程当前还活着或已退出。',
              })}
            </span>
          </div>
        ) : (
          <div data-testid="farm-telemetry-drawer-process-signal-none">
            <span className="status-badge muted">
              {t('farm.telemetry.psNoSignal', { defaultValue: '无信号' })}
            </span>
            <p className={styles.drawerCaveat}>
              {t('farm.telemetry.psNoSignalCaveat', {
                defaultValue:
                  '该信标未携带进程退出信号（当前仅 datadog_logs 的 terminated 事件会带）。无信号既不代表进程还活着、也不代表异常——只代表这条上报没有携带退出信号。',
              })}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// reported_fields 一行：label | value；空值显 '—'（诚实缺失）；masked=true 的字段
// 由服务端已脱敏，仅加 tooltip 说明，不再前端二次处理。
function FragmentRow({ label, value, masked }: { label: string; value: string; masked?: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <span className={styles.fieldSpreadLabel}>{label}</span>
      <span
        className={styles.fieldSpreadValue}
        title={
          masked && value
            ? t('farm.telemetry.maskedHint', {
                defaultValue: '展示脱敏（前 12 + 后 4），完整值仅服务端保留',
              })
            : undefined
        }
      >
        {value || '—'}
      </span>
    </>
  );
}
