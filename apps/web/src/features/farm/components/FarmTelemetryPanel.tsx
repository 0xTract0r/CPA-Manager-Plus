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
import { formatCompactStampUtc8, formatDateTimeUtc8 } from '@/utils/datetime';
import { formatFileSize } from '@/utils/format';
import { useFarmContainerBeacons } from '../hooks/useFarmContainerBeacons';
import {
  normalizeFarmTelemetrySilenceState,
  telemetrySilenceStateToBadgeVariant,
} from '../utils/health';
import { maskTelemetryFingerprint } from '../utils/identity';
import { displayFingerprintValue, fingerprintFieldsClash } from '../utils/telemetry';
import { BeaconDetailBody } from './FarmBeaconDetailBody';
import styles from './FarmTelemetryPanel.module.scss';

// beacon 时间线默认只渲染最近 N 条，避免容器上报密集时一次性渲染成百上千行把
// ~640px 窄抽屉挤成字墙；超出部分靠「展开更多」按需加载。
const BEACON_TIMELINE_DEFAULT_LIMIT = 20;

// beacon 时间线单元格的紧凑时间戳走 formatCompactStampUtc8：`MM/DD HH:mm:ss`（24 小时制，
// 分隔符与 locale 无关，绝不掺 en-US 的 `,` 逗号——否则列宽随 locale 抖动把秒挤掉，P1-3）；
// 完整含 UTC±H 标注的时间戳放进 title 悬浮备查。

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

  // on-wire 一侧仍按 source_kind 分区（保持 captured_at 降序）：逐字段选值时取
  // 「该来源最近一条带该值」的 beacon，而不是整列绑定同一条 beacon（修横线的核心）。
  // farm-proxy-rotation §5：指纹卡的「declared」列已换成「预期(pin)」，数据源改读
  // container.fingerprint_pin（见下方指纹自洽卡渲染段），不再需要按 declared 分区
  // beacon，故此处不再声明 declaredBeacons（避免 noUnusedLocals 编译错误）。
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

  // 「遥测停摆四态」（farm-egress-resilience Change A）：代理死 / 出站黑洞 / 进程死 /
  // 正常无请求 / 待确认，取代单一「偏旧」。以后端 telemetry_silence_state 为权威判据，
  // 归一化兜底把缺失/未知值落到 indeterminate（待确认，绝不臆断乐观结论）。字段整体
  // 缺失（旧编排器未透传）时 silenceStateView 为空，回退既有 is_stale 呈现。
  const silenceStateView = container.telemetry_silence_state;
  const silenceState = silenceStateView
    ? normalizeFarmTelemetrySilenceState(silenceStateView.state)
    : null;
  const silenceProbe = silenceStateView?.probe ?? null;
  const silenceProcessTerminated = silenceStateView?.process_terminated ?? false;
  // active 表示遥测在流动、压根没停摆——不进四态诊断盒，只在新鲜度徽标显「较新」。
  // 「从未观测」容器且既无探针又无进程死信号时，state 只会是 indeterminate；此时
  // 「从未观测」徽标已是最诚实的表述，不再叠一个「待确认」盒制造噪声——只有真正
  // 有可行动证据（探针快照 / 进程终止信号）时才展开诊断盒。
  const showSilenceDiagnosis =
    silenceState != null &&
    silenceState !== 'active' &&
    (!neverObserved || silenceProbe != null || silenceProcessTerminated);

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
        {/* 指纹自洽卡（farm-proxy-rotation §5「指纹卡 pin」）：预期 (pin，编排器钉给该
            容器的意图身份，container.fingerprint_pin) vs on-wire（出站实测），逐字段
            对照；不一致即撞红=泄露。判等逻辑等价于 utils/telemetry.ts 新增的
            pinFieldClash（该文件是这段逻辑的规范实现 + 单测锁定），本文件因 NOCLASH
            冻结 import 行未直接 import，下方内联复刻同款判等，只复用本文件已导入的
            fingerprintFieldsClash / displayFingerprintValue，留给集成阶段收敛成同一份。 */}
        <div className={styles.estimateBox} data-testid="farm-telemetry-consistency">
          <div className={`${styles.consistencyGrid} ${styles.consistencyHeaderRow}`}>
            <span className={styles.chartLabel}>
              {t('farm.telemetry.fieldColumn', { defaultValue: '指纹字段' })}
            </span>
            <span
              className={styles.chartLabel}
              data-testid="farm-telemetry-pin-column-header"
              title={t('farm.telemetry.pin.columnHint', {
                defaultValue:
                  '编排器钉给该容器的预期指纹；on-wire 实测逐字段与它对照——任一不一致即泄露。',
              })}
            >
              {t('farm.telemetry.pin.column', { defaultValue: '预期 (pin)' })}
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
                  '该容器当前窗口内暂未观测到 on-wire 信标（mitmproxy/ebpf 出站抓取），下方「出站实测」列暂为占位；逐字段派生已接入，一旦抓到任意 on-wire 信标即自动点亮并与预期(pin)值比对。',
              })}
            </p>
          )}

          {/* pin 卡存在性门控：container.fingerprint_pin 整体缺失时（旧编排器/字段裁剪
              防御，正常情况后端恒填充，见 types/farm.ts FarmContainerView 注释）不渲染
              任何 pin 值，只标一行诚实占位横幅；下方逐字段仍复用同一套渲染，pinRaw 全空
              时 fingerprintFieldsClash 空串即不比较，自然不会误撞红。 */}
          {!container.fingerprint_pin && (
            <p className={styles.onWireBanner} data-testid="farm-telemetry-pin-missing-banner">
              {t('farm.telemetry.pin.missingBanner', {
                defaultValue:
                  '该容器暂无编排器钉死的预期指纹（旧编排器未下发或字段被裁剪），下方「预期(pin)」列暂为占位，不构成泄露判定依据。',
              })}
            </p>
          )}

          {(() => {
            const pin = container.fingerprint_pin;
            const rows = FARM_TELEMETRY_FINGERPRINT_FIELDS.map((field) => {
              // pin 侧不走 beacon，直接读容器的意图身份三字段；device_id 一项后端起就
              // 只下发脱敏值（绝不明文，见 types/farm.ts 注释），这里不再二次脱敏。
              let pinRaw = '';
              if (pin) {
                if (field === 'device_id') pinRaw = pin.device_id_masked;
                else if (field === 'entrypoint') pinRaw = pin.entrypoint;
                else if (field === 'api_base_url_host') pinRaw = pin.api_base_url_host;
              }
              // on-wire 侧不变：逐字段选「该来源最近一条带值」的原始值，先判等/撞红、
              // 再脱敏展示（顺序不能反，见 utils/telemetry.ts 注释）。
              const onWireRaw = onWireCaptured
                ? pickLatestBeaconFieldValue(onWireBeacons, field)
                : null;
              const onWirePending = onWireRaw === null;
              const onWireDisplay = onWirePending
                ? ''
                : displayFingerprintValue(field, onWireRaw ?? '');
              // 撞红=泄露：on-wire 原始值先按 displayFingerprintValue 同款规则处理，
              // 与 pinRaw 落到同一表示层级（device_id 两侧都是脱敏串，其余两个低熵
              // 字段两侧都是原始值）后再复用 fingerprintFieldsClash 的三态判等语义。
              const clash = fingerprintFieldsClash(pinRaw, onWireDisplay);
              const pinHasValue = pinRaw !== '';
              const clashClassName = clash ? ` ${styles.consistencyValueClash}` : '';
              const onWireClassName = onWirePending
                ? `${styles.mono} ${styles.onWirePlaceholder}`
                : `${styles.mono} ${styles.consistencyValue}${clashClassName}`;
              return {
                field,
                pinRaw,
                pinHasValue,
                onWirePending,
                onWireDisplay,
                clash,
                clashClassName,
                onWireClassName,
              };
            });
            const deviceIdClash = rows.find((r) => r.field === 'device_id')?.clash ?? false;
            return (
              <>
                {rows.map((row) => (
                  <div
                    key={row.field}
                    data-testid={`farm-telemetry-consistency-row-${row.field}`}
                    data-field={row.field}
                    data-clash={row.clash ? 'true' : 'false'}
                    className={`${styles.consistencyGrid} ${styles.consistencyRow}`}
                  >
                    <span className={styles.mono}>
                      {t(`farm.telemetry.pin.label_${row.field}`, { defaultValue: row.field })}
                    </span>
                    {row.pinHasValue ? (
                      <span
                        data-testid={`farm-telemetry-pin-${row.field}`}
                        className={`${styles.mono} ${styles.consistencyValue}${row.clashClassName}`}
                      >
                        {row.pinRaw}
                        {row.clash && (
                          // 撞红不能只靠红色文字传达（WCAG 1.4.1）：叠加图标 + 「泄露」
                          // 文案，title 再带一句解释，屏幕阅读器与色弱用户都能读到。
                          <span
                            className={styles.consistencyValueClash}
                            data-testid={`farm-telemetry-pin-leak-${row.field}`}
                            title={t('farm.telemetry.pin.leakHint', {
                              defaultValue: 'on-wire 实测与 pin 不一致——指纹泄露。',
                            })}
                          >
                            {' '}
                            <span aria-hidden="true">⚠</span>{' '}
                            {t('farm.telemetry.pin.leak', { defaultValue: '泄露' })}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span
                        data-testid={`farm-telemetry-pin-${row.field}`}
                        data-pin-empty="true"
                        className={styles.declaredNotCollected}
                        title={t('farm.telemetry.pin.notPinnedHint', {
                          defaultValue:
                            '编排器未给该容器钉死这个字段的预期值（旧编排器/字段裁剪）；此处不编造值，也不据此判定泄露。',
                        })}
                      >
                        {t('farm.telemetry.pin.notPinned', { defaultValue: '未配置 (pin)' })}
                      </span>
                    )}
                    <span
                      data-testid={`farm-telemetry-onwire-${row.field}`}
                      data-pending={row.onWirePending ? 'true' : 'false'}
                      className={row.onWireClassName}
                      // 「—」跨区一致性（U-review P2）：on-wire 列的横线不再是无解释的
                      // 裸占位——统一挂 title 说明「该字段在本窗口的 on-wire 信标里没出现
                      // （如 datadog_logs 通道天然不带 device_id），非泄露也非数据丢失」，
                      // 与逐条来源标注口径一致。
                      title={
                        row.onWirePending
                          ? t('farm.telemetry.onWirePendingDashHint', {
                              defaultValue:
                                '「—」表示当前窗口内没有 on-wire 信标携带该字段（例如 datadog_logs 通道天然不带 device_id）——既非泄露也非数据丢失。',
                            })
                          : undefined
                      }
                    >
                      {row.onWirePending ? '—' : row.onWireDisplay || '—'}
                    </span>
                  </div>
                ))}
                {/* device_id 撞红是最强的身份泄露信号：除了逐字段的红字 + 「泄露」文案，
                    额外叠一个更显眼的告警盒（图标 + 加粗文案，同样不单靠颜色，满足
                    WCAG 1.4.1）。复用 .silenceStateBox 的 error 变体视觉，不新增样式类
                    （本文件 scss module 冻结，见 NOCLASH 分工）。 */}
                {deviceIdClash && (
                  <div
                    className={styles.silenceStateBox}
                    data-silence-variant="error"
                    data-testid="farm-telemetry-pin-device-id-alert"
                  >
                    <div className={styles.silenceStateHead}>
                      <span aria-hidden="true">⚠️</span>
                      <span className="status-badge error">
                        {t('farm.telemetry.pin.deviceIdMismatchWarning', {
                          defaultValue:
                            'device_id 不一致：on-wire 值与钉死的 device_id 不同——大概率身份泄露，请排查。',
                        })}
                      </span>
                    </div>
                    <p className={styles.silenceStateConclusion}>
                      {t('farm.telemetry.pin.deviceIdMismatchHint', {
                        defaultValue:
                          '钉死的 device_id 与 on-wire device_id 在同款脱敏后仍不匹配。',
                      })}
                    </p>
                  </div>
                )}
              </>
            );
          })()}
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
          data-silence-state={silenceState ?? ''}
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
          ) : silenceState ? (
            // 四态徽标：以后端 telemetry_silence_state 为准，取代单一 偏旧/较新 二元。
            // active=较新(success)、idle_no_request=正常无请求(muted)、proxy_dead/
            // egress_blackhole/process_dead=确证故障(error)、indeterminate=待确认(warning)。
            <>
              <span
                className={`status-badge ${telemetrySilenceStateToBadgeVariant(silenceState)}`}
                data-testid="farm-telemetry-freshness-badge"
                data-silence-state={silenceState}
              >
                {t(`farm.telemetry.silenceState.label_${silenceState}`, {
                  defaultValue: silenceState,
                })}
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
        {/* 遥测停摆四态诊断盒（farm-egress-resilience Change A）：取代单一「遥测太旧」，
            按 state 显具体结论 + 建议动作 + 探针证据。诚实边界：indeterminate 显式
            「待确认」，绝不臆断「正常」。字段整体缺失（旧编排器）时回退下方 staleWarning。 */}
        {showSilenceDiagnosis && silenceState ? (
          <div
            className={styles.silenceStateBox}
            data-testid="farm-telemetry-silence-state"
            data-silence-state={silenceState}
            data-silence-variant={telemetrySilenceStateToBadgeVariant(silenceState)}
          >
            <div className={styles.silenceStateHead}>
              <span
                className={`status-badge ${telemetrySilenceStateToBadgeVariant(silenceState)}`}
                data-testid="farm-telemetry-silence-state-badge"
              >
                {t(`farm.telemetry.silenceState.label_${silenceState}`, {
                  defaultValue: silenceState,
                })}
              </span>
              {minutesSinceLast != null && silence ? (
                <span className={styles.hintText}>
                  {t('farm.telemetry.silenceState.silenceDuration', {
                    defaultValue: '已静默约 {{minutes}} 分钟（门槛 {{threshold}} 分钟）',
                    minutes: minutesSinceLast,
                    threshold: Math.round(silence.threshold_minutes),
                  })}
                </span>
              ) : null}
            </div>
            <p
              className={styles.silenceStateConclusion}
              data-testid="farm-telemetry-silence-conclusion"
            >
              {t(`farm.telemetry.silenceState.conclusion_${silenceState}`, {
                defaultValue: silenceState,
              })}
            </p>
            <p className={styles.silenceStateAction} data-testid="farm-telemetry-silence-action">
              <span className={styles.silenceStateActionLabel}>
                {t('farm.telemetry.silenceState.actionLabel', { defaultValue: '建议动作' })}
              </span>
              <span>
                {t(`farm.telemetry.silenceState.action_${silenceState}`, {
                  defaultValue: silenceState,
                })}
              </span>
            </p>
            {silenceProbe ? (
              <div className={styles.silenceStateProbe} data-testid="farm-telemetry-silence-probe">
                <span className={styles.silenceStateProbeHead}>
                  {t('farm.telemetry.silenceState.probeHeading', { defaultValue: '出站探针快照' })}
                  {silenceProbe.stale ? (
                    <span
                      className="status-badge muted"
                      data-testid="farm-telemetry-silence-probe-stale"
                      title={t('farm.telemetry.silenceState.probeStaleHint', {
                        defaultValue: '探针已超新鲜度窗口，四态判定已不信任它描述当下网络态。',
                      })}
                    >
                      {t('farm.telemetry.silenceState.probeStale', { defaultValue: '探针已过期' })}
                    </span>
                  ) : null}
                </span>
                <div className={styles.silenceStateProbeGrid}>
                  <span className={styles.silenceStateProbeLabel}>
                    {t('farm.telemetry.silenceState.probeProxyDirect', { defaultValue: '代理直连' })}
                  </span>
                  <span
                    data-testid="farm-telemetry-silence-probe-proxy"
                    data-ok={silenceProbe.proxy_direct_ok ? 'true' : 'false'}
                  >
                    {silenceProbe.proxy_direct_ok
                      ? t('farm.telemetry.silenceState.probeOk', { defaultValue: '通' })
                      : t('farm.telemetry.silenceState.probeFail', { defaultValue: '不通' })}
                  </span>
                  <span className={styles.silenceStateProbeLabel}>
                    {t('farm.telemetry.silenceState.probeEgressCanary', {
                      defaultValue: '出站 canary',
                    })}
                  </span>
                  <span
                    data-testid="farm-telemetry-silence-probe-canary"
                    data-ok={silenceProbe.egress_canary_ok ? 'true' : 'false'}
                  >
                    {silenceProbe.egress_canary_ok
                      ? t('farm.telemetry.silenceState.probeOk', { defaultValue: '通' })
                      : t('farm.telemetry.silenceState.probeFail', { defaultValue: '不通' })}
                  </span>
                  <span className={styles.silenceStateProbeLabel}>
                    {t('farm.telemetry.silenceState.probeRedsocks', {
                      defaultValue: 'redsocks 连接表',
                    })}
                  </span>
                  <span
                    data-testid="farm-telemetry-silence-probe-redsocks"
                    data-saturated={silenceProbe.redsocks_saturated ? 'true' : 'false'}
                  >
                    {silenceProbe.redsocks_saturated
                      ? t('farm.telemetry.silenceState.probeSaturated', {
                          defaultValue:
                            '饱和（recvQ {{recvQ}} / backlog {{backlog}} / closeWait {{closeWait}}）',
                          recvQ: silenceProbe.redsocks_recv_q,
                          backlog: silenceProbe.redsocks_backlog,
                          closeWait: silenceProbe.redsocks_close_wait,
                        })
                      : t('farm.telemetry.silenceState.probeNotSaturated', { defaultValue: '正常' })}
                  </span>
                </div>
                <span className={styles.hintText}>
                  {t('farm.telemetry.silenceState.probeCheckedAt', {
                    defaultValue: '探针时间：{{time}}',
                    time: formatDateTimeUtc8(silenceProbe.checked_at, i18n.language),
                  })}
                </span>
              </div>
            ) : (
              <p className={styles.hintText} data-testid="farm-telemetry-silence-probe-none">
                {t('farm.telemetry.silenceState.probeNone', {
                  defaultValue:
                    '无出站探针快照（探针未上报 / 未装配）——缺网络层判据，无法区分出站黑洞与正常没请求，只能落进程死或待确认，绝不臆断。',
                })}
              </p>
            )}
            {silenceProcessTerminated ? (
              <p
                className={styles.hintText}
                data-testid="farm-telemetry-silence-proc-terminated"
              >
                {t('farm.telemetry.silenceState.processTerminated', {
                  defaultValue: '最近一条 beacon 携带进程终止信号。',
                })}
              </p>
            ) : null}
          </div>
        ) : silenceState == null && isStale && silence ? (
          // 回退：编排器未返回四态字段（旧版本）时，保留既有单态「遥测太旧」告警。
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
                  const capturedAtCompact = formatCompactStampUtc8(beacon.captured_at, '—');
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
