import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTimezone } from '@/hooks/useTimezone';
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
import { maskTelemetryFingerprint } from '../utils/identity';
import { displayFingerprintValue, fingerprintFieldsClash } from '../utils/telemetry';
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

// 从某条 beacon（已按 source_kind 选好——declared 列传最近一条 declared beacon，
// on-wire 列传最近一条 on_wire beacon）取某个指纹字段的值。字段本身是后端
// ParseBeacon 在入库时抽取好的（見 telemetry_beacon.go handleIngestBeacons），
// 前端不解析原始 body，只是按 source_kind 分区挑「该来源最近一条」。
function fieldValueFromBeacon(
  beacon: FarmContainerBeaconView | undefined,
  field: FarmTelemetryFingerprintField
): string {
  if (!beacon) return '';
  return beacon[field] ?? '';
}

// 指纹自洽卡 declared 列：最近一条 declared beacon 的字段值。
function declaredFieldValue(
  latestDeclared: FarmContainerBeaconView | undefined,
  field: FarmTelemetryFingerprintField
): string {
  return fieldValueFromBeacon(latestDeclared, field);
}

// 指纹自洽卡 on-wire 列（TP-1「点亮 on-wire 逐字段」）：取「最近一条
// source_kind=on_wire 的 beacon」（真实 mitmproxy/ebpf 出站抓取，见
// resolveBeaconSourceKind），读它已由服务端抽取好的字段值。
//
// 返回值三态语义（调用方据此区分「真占位」vs「有实测但为空」）：
//   - null：从未观测到任何 on_wire beacon（该容器/该窗口内），列仍是中性占位。
//   - ''（空串）：观测到过 on_wire beacon，但该字段这次抓取没能提取出值（如
//     datadog_logs 通道没有 device_id 字段，ParseBeacon 如实留空、不编造）——
//     这不是「未接入」，是「这条真实请求确实没带这个字段」，不应误判为占位。
//   - 非空串：该字段的实测值。
function onWireFieldValue(
  latestOnWire: FarmContainerBeaconView | undefined,
  field: FarmTelemetryFingerprintField
): string | null {
  if (!latestOnWire) return null;
  return fieldValueFromBeacon(latestOnWire, field);
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
 * 另一件相关的事（TP-1 已接入）：指纹自洽卡的「出站实测 (on-wire)」一列取「最近
 * 一条 source_kind=on_wire 的 beacon」，读它已由服务端 ParseBeacon 抽取好的字段
 * 值——前端不解析原始 body。从未观测到任何 on_wire beacon 时该列仍是中性占位
 * （真占位，不是「尚未接入」），由卡顶一条面板级横幅统一说明；一旦观测到任意
 * on_wire beacon，横幅自动收起（见 onWireCaptured）。declared 与 on-wire 同一字段
 * 都有实测值且不一致时撞红（见 clash 判定，仅当 on-wire 侧确有值才比较，避免把
 * 「这条实测请求没带这个字段」误判成冲突）。
 *
 * TP-2「每容器遥测内容更丰富」：面板另增一节「遥测字段速览」，把 declared/on-wire
 * 各自最近一条 beacon 的全部已知字段（channel/host/path/body_bytes/captured_at/
 * source 以及脱敏后的 device_id/api_base_url_host/entrypoint）铺开展示，而不是只
 * 有指纹自洽卡的 3 个比对字段。session_id/app_version/user_type/event_names 四个
 * 字段服务端已解析落库但对外只读接口尚未暴露（见 types/farm.ts
 * FarmContainerBeaconView 同名字段注释），前端已前瞻声明类型、存在性门控渲染
 * （不渲染，不是显示占位符），后端补齐后自动点亮。
 *
 * 取数走 useFarmContainerBeacons（GET .../beacons，裸数组、captured_at 降序）：
 * 失败态经 AsyncPanel 如实呈现，不吞不伪造；空容器（后端返回 []）在数据态内
 * 以内联空提示处理，而不是把整卡（含来源边界说明）替换成空态卡片——逐条来源
 * 标注与 on-wire 列口径说明在任何数据量下都必须可见。
 */
export function FarmTelemetryPanel({ container }: FarmTelemetryPanelProps) {
  const { t, i18n } = useTranslation();
  // 订阅全局时区（TZ2/#49）：切换时区时本组件重渲染，内部 formatDateTimeUtc8 同步刷新。
  useTimezone();
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
  // TP-1：declared 列与 on-wire 列各取「该来源最近一条」，不是同一条 beacon 的
  // 两个视角——beacons 已按 captured_at 降序，`.find` 拿到的就是各自最近一条。
  const latestDeclaredBeacon = useMemo(
    () => beacons.find((b) => resolveBeaconSourceKind(b) === 'declared'),
    [beacons]
  );
  const latestOnWireBeacon = useMemo(
    () => beacons.find((b) => resolveBeaconSourceKind(b) === 'on_wire'),
    [beacons]
  );
  // TP-2「字段速览」快照：优先展示最近一条 on-wire 信标（真实出站抓取，最具权威），
  // 无 on-wire 时回退最近一条信标（自报），下方按 source_kind 明确标注来源，不冒充。
  const spreadBeacon = latestOnWireBeacon ?? latestBeacon;
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

  // on-wire 采集管道是否已观测到该容器的任意 on_wire beacon（TP-1）：只要存在
  // 一条即为 true，与「这条 beacon 具体哪些字段抽取出了值」无关——即便某条
  // on_wire beacon 因通道限制（如 datadog_logs 没有 device_id）导致某个字段为
  // 空串，也不能倒推回「没抓到 on-wire 数据」。面板级横幅据此收起。
  const onWireCaptured = Boolean(latestOnWireBeacon);

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
              '下方是该容器的遥测信标列表，混合两类来源并逐条标注：「自报 (declared)」是容器声明/自报的内容，「on-wire」行才是 mitmproxy/ebpf 在容器出站链路真实抓取的数据。即便 on-wire 行也只证明该容器确实发出过这些请求，不构成跨账号反关联证明。上方指纹自洽卡的「出站实测 (on-wire)」列取最近一条 on-wire 信标已由服务端抽取好的字段与自报值逐字段比对——该容器暂未抓到 on-wire 信标时该列显占位（真占位，不是功能未接入）。',
          })}
        </p>
      </details>
      <span className={styles.scopeBadge} data-testid="farm-telemetry-scope">
        {t('farm.telemetry.scopeBadge', {
          defaultValue: '口径：信标含自报与 on-wire 两类·逐条标注来源，指纹逐字段派生已接入',
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

          {/* 面板级横幅（TP-1）：逐字段 on-wire 派生**已接入**，只是该容器在当前
              窗口内还没观测到任何 on_wire 信标（mitmproxy/ebpf 出站抓取），所以下方
              on-wire 列暂为中性占位。一旦抓到任意 on_wire 信标即自动点亮并与自报值
              逐字段比对，横幅随之收起（见 onWireCaptured）。这是「该容器还没产生真实
              出站抓取」，不是「功能没接入」。 */}
          {!onWireCaptured && (
            <p className={styles.onWireBanner} data-testid="farm-telemetry-onwire-banner">
              {t('farm.telemetry.onWireBanner', {
                defaultValue:
                  '该容器当前窗口内暂未观测到 on-wire 信标（mitmproxy/ebpf 出站抓取），下方「出站实测」列暂为占位；逐字段派生已接入，一旦抓到任意 on-wire 信标即自动点亮并与自报值比对。',
              })}
            </p>
          )}

          {FARM_TELEMETRY_FINGERPRINT_FIELDS.map((field) => {
            // TP-1：declared 取「最近一条 declared beacon」、on-wire 取「最近一条
            // source_kind=on_wire beacon」的**原始值**——先用原始值判等/撞红
            // （fingerprintFieldsClash），再各自脱敏展示（displayFingerprintValue，
            // 仅 device_id 这类高熵字段前 12+后 4 折叠），顺序不能反（否则会把首尾
            // 恰好相同的两个不同值误判为一致，见 utils/identity.ts 注释）。
            const declaredRaw = declaredFieldValue(latestDeclaredBeacon, field);
            const onWireRaw = onWireFieldValue(latestOnWireBeacon, field);
            const onWirePending = onWireRaw === null;
            const clash = fingerprintFieldsClash(declaredRaw, onWireRaw);
            const declaredDisplay = displayFingerprintValue(field, declaredRaw);
            const onWireDisplay = onWirePending
              ? ''
              : displayFingerprintValue(field, onWireRaw ?? '');
            const declaredClassName = `${styles.mono} ${styles.consistencyValue}${
              clash ? ` ${styles.consistencyValueClash}` : ''
            }`;
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
                  {declaredDisplay || '—'}
                </span>
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

        {/* TP-2「每容器遥测内容更丰富」：把最近一条信标已抽取好的字段铺开展示，不
            只 host——设备 ID / 会话 ID（脱敏）/ API base host / 入口 / 客户端版本 /
            用户类型 / 事件名 / 通道 / host / 路径 / 请求体大小 / 采集时间。source_kind
            逐条标注来源。session_id/app_version/user_type/event_names 四个字段服务端
            已落库但只读端点尚未序列化（见 types/farm.ts FarmContainerBeaconView 注释），
            此处**存在性门控**——缺失时整行不渲染（不显示占位符、不臆造），后端补齐后
            自动点亮。device_id/session_id 走 maskTelemetryFingerprint 脱敏（前 12+后 4）。 */}
        {spreadBeacon ? (
          (() => {
            const spreadKind = resolveBeaconSourceKind(spreadBeacon);
            const spreadIsOnWire = spreadKind === 'on_wire';
            const spreadRawSource =
              spreadBeacon.source || (spreadIsOnWire ? 'mitmproxy' : 'declared');
            const maskedDeviceId = maskTelemetryFingerprint(spreadBeacon.device_id);
            const maskedSessionId = maskTelemetryFingerprint(spreadBeacon.session_id);
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

                  {maskedDeviceId ? (
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
                        {maskedDeviceId}
                      </span>
                    </>
                  ) : null}

                  {maskedSessionId ? (
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
                        {maskedSessionId}
                      </span>
                    </>
                  ) : null}

                  {spreadBeacon.api_base_url_host ? (
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
                        {spreadBeacon.api_base_url_host}
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

                  {spreadBeacon.app_version ? (
                    <>
                      <span className={styles.fieldSpreadLabel}>
                        {t('farm.telemetry.spreadAppVersion', { defaultValue: '客户端版本' })}
                      </span>
                      <span
                        className={styles.fieldSpreadValue}
                        data-testid="farm-telemetry-spread-app-version"
                      >
                        {spreadBeacon.app_version}
                      </span>
                    </>
                  ) : null}

                  {spreadBeacon.user_type ? (
                    <>
                      <span className={styles.fieldSpreadLabel}>
                        {t('farm.telemetry.spreadUserType', { defaultValue: '用户类型' })}
                      </span>
                      <span
                        className={styles.fieldSpreadValue}
                        data-testid="farm-telemetry-spread-user-type"
                      >
                        {spreadBeacon.user_type}
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
              '此处 device_id / session_id 展示均脱敏（前 12 + 后 4），完整值仅服务端保留、不经该只读接口回吐前端；判等/撞红在服务端与前端均以原始值为准，脱敏只作展示。漂移/串号/host 泄漏等自洽异常经告警面板呈现。',
          })}
        </p>
      </AsyncPanel>
    </section>
  );
}
