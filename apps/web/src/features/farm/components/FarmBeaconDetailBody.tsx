import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { JsonView } from 'react-json-view-lite';
import 'react-json-view-lite/dist/index.css';
import { useTimezone } from '@/hooks/useTimezone';
import { resolveBeaconSourceKind, type FarmContainerBeaconView } from '@/types/farm';
import { copyToClipboard } from '@/utils/clipboard';
import { formatDateTimeUtc8 } from '@/utils/datetime';
import { formatFileSize } from '@/utils/format';
import { useFarmBeaconRedactedBody } from '../hooks/useFarmContainerBeacons';
import detailStyles from './FarmBeaconDetailBody.module.scss';
import styles from './FarmTelemetryPanel.module.scss';

/**
 * 信标详情抽屉正文：单条 beacon 的完整上报内容。**这条 beacon 是 Claude Code 的内部
 * 遥测**（statsig_eval / event_logging / datadog_logs），不是 LLM /v1/messages 业务请求；
 * 反关联要核的指纹字段后端已抽成结构化字段，前端不解析原始 body 语义。
 *
 * 本次（Option A 重设计，farm-beacon-body-structured-view）把视图重排成「结构化指纹
 * 摘要为主 + 原始 body 降为按需」，根治此前默认糊一坨**被截断的原始 JSON**（截断→非法
 * JSON→退回 raw 单行密文铺满整屏）读不了、零价值的问题：
 *
 *   1. **首屏 = 指纹摘要**（永远有效、永不截断、零后端依赖）：把 beacon 已由后端抽好的
 *      指纹字段（device_id 全量 / api_base_url_host / entrypoint / channel / 来源 / 采集
 *      时间 / host / path / 请求体大小）用既有 KV 网格铺开，作为详情抽屉的主内容。
 *   2. **原始 body 降为按需、永不成墙**：body_preview 能 JSON.parse（小而完整，如
 *      statsig_eval）→ react-json-view-lite 可折叠树内联渲染；parse 不了（预览被截断成
 *      非法 JSON）→ **不铺 raw**，只给一行中性提示引导看完整请求体；点「查看完整请求体」
 *      才惰性调 GET .../beacons/{beaconID}/redacted-body 取完整脱敏 body（同样折叠树），
 *      64K 安全上限被裁时标注；该端点不可用/失败 **fail-soft**（不破坏摘要视图、不整页崩）。
 *   3. reported_fields（脱敏）/ event_names / process_signal 作为补充分节，后两者「有才显」。
 *
 * 只展示后端脱敏值，不编造缺失字段；缺失字段一律 '—'（诚实）。
 */

// 与后端 beacon_redact.go bodyPreviewTruncationMarker 字面量保持一致（前端无法读取 Go
// 常量，此处显式复制）：仅用于区分「预览被截断成非法 JSON」与「本就非 JSON」，不改变
// 渲染分支本身，只影响提示文案的准确性。
const TRUNCATION_MARKER = '…(truncated)';

// react-json-view-lite 的展开深度控制，**按 variant 分档**（此前 preview / full 共用
// `level < 2`，导致点开「查看完整请求体」后每个 event 仍被折叠成一排空 `{}`——见下）：
//
//   - preview：顶层 + 第一层展开、更深层折叠。body_preview 常是被上游截断的小体，浅
//     展开避免列表在抽屉里过度铺开；与 AuthFilesAccountSettingsModal 只读树同款
//     `level < 2` 口径。
//   - full：用户已显式点「查看完整请求体」——**全展开**。遥测完整体形如
//     `{"events":[{"event_type":…,"event_data":{"event_name":…,"model":…,"device_id":…}}]}`：
//     root=level0、events 数组=level1、**每个 event 对象=level2**、event_data=level3。
//     `level < 2` 会把 level2 的每个 event 折叠掉，而 react-json-view-lite 把折叠对象
//     渲染成**字面空 `{}`**（空 span、无省略号），于是一段合法 JSON 看着像一排空对象、
//     指纹字段全不可见。full 视图恒展开，确保 event_name/model/device_id/env 等真实可读。
const expandTelemetryBodyPreview = (level: number) => level < 2;
const expandTelemetryBodyFull = () => true;

// react-json-view-lite 主题类名映射（复用 FarmBeaconDetailBody.module.scss 内自带的
// jsonTree* 皮肤，与 AuthFilesAccountSettingsModal 的只读 JSON 树同款设计 token）。
const JSON_TREE_STYLE = {
  container: detailStyles.jsonTreeContainer,
  childFieldsContainer: detailStyles.jsonTreeChildFields,
  basicChildStyle: detailStyles.jsonTreeChild,
  label: detailStyles.jsonTreeLabel,
  clickableLabel: detailStyles.jsonTreeClickableLabel,
  nullValue: detailStyles.jsonTreeNull,
  undefinedValue: detailStyles.jsonTreeNull,
  numberValue: detailStyles.jsonTreeNumber,
  stringValue: detailStyles.jsonTreeString,
  booleanValue: detailStyles.jsonTreeBoolean,
  otherValue: detailStyles.jsonTreeOther,
  punctuation: detailStyles.jsonTreePunctuation,
  expandIcon: detailStyles.jsonTreeExpandIcon,
  collapseIcon: detailStyles.jsonTreeCollapseIcon,
  collapsedContent: detailStyles.jsonTreeCollapsedContent,
  quotesForFieldNames: true,
  stringifyStringValues: true,
} as const;

export function BeaconDetailBody({
  beacon,
  containerId,
}: {
  beacon: FarmContainerBeaconView;
  // 承载该 beacon 的容器 id（FarmTelemetryPanel 下传）：调「查看完整请求体」端点必需。
  // null（理论上抽屉打开时不会发生）时「查看完整请求体」入口优雅降级为不可用。
  containerId: string | null;
}) {
  const { t, i18n } = useTranslation();
  useTimezone();

  const sourceKind = resolveBeaconSourceKind(beacon);
  const isOnWire = sourceKind === 'on_wire';
  const rawSource = beacon.source || (isOnWire ? 'mitmproxy' : 'declared');
  const rf = beacon.reported_fields;
  const eventNames = beacon.event_names?.filter(Boolean) ?? [];
  const ps = beacon.process_signal;
  const bodyPreview = beacon.body_preview ?? '';

  // 「查看完整请求体」按需展开态：默认收起，只展示首屏摘要 + 预览。点开才调
  // GET .../beacons/{beaconID}/redacted-body 取完整脱敏 body。beacon_id 缺失（旧编排器）
  // 或无容器 id 时，入口不可用（不渲染按钮），仅保留预览——优雅降级。
  const [showFullBody, setShowFullBody] = useState(false);
  const hasBeaconId = typeof beacon.beacon_id === 'number' && beacon.beacon_id > 0;
  const canLoadFullBody = hasBeaconId && !!containerId;
  const {
    data: fullBody,
    loading: fullBodyLoading,
    error: fullBodyError,
  } = useFarmBeaconRedactedBody(
    containerId,
    hasBeaconId ? beacon.beacon_id : null,
    showFullBody && canLoadFullBody
  );

  // 事件名去重 + 按出现频次降序（同频次保留首次出现顺序——Map 按插入顺序迭代 +
  // Array.sort 稳定排序天然满足）。只做计数展示，不改变 eventNames 的原始语义。
  const eventNameCounts: Array<{ name: string; count: number }> = useMemo(() => {
    const counts = new Map<string, number>();
    for (const name of eventNames) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [eventNames]);

  // 首屏「指纹摘要」逐字段：后端 ParseBeacon 已抽好的顶层指纹字段（device_id 全量、
  // api_base_url_host、entrypoint、channel）。缺失显 '—'（诚实，代表这条 beacon 没带）。
  const summaryRows: Array<{ key: string; label: string; value: string; hint?: string }> = [
    {
      key: 'device_id',
      label: t('farm.telemetry.field_device_id', { defaultValue: 'device_id' }),
      value: beacon.device_id,
      hint: t('farm.telemetry.beaconBody.deviceIdFullHint', {
        defaultValue: '自报全量值（非脱敏），仅供运维核对自洽性。',
      }),
    },
    {
      key: 'api_base_url_host',
      label: t('farm.telemetry.field_api_base_url_host', { defaultValue: 'api_base_url_host' }),
      value: beacon.api_base_url_host,
    },
    {
      key: 'entrypoint',
      label: t('farm.telemetry.field_entrypoint', { defaultValue: 'entrypoint' }),
      value: beacon.entrypoint,
    },
    {
      key: 'channel',
      label: t('farm.telemetry.spreadChannel', { defaultValue: '通道' }),
      value: beacon.channel,
    },
  ];

  // reported_fields 逐字段（脱敏）：缺失显 '—'（诚实）。device_id/session_id 由服务端
  // 脱敏（前 12 + 后 4），其余为低敏元数据原样透传。
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
      {/* 首屏主内容：指纹摘要（后端已抽好的结构化字段，永不截断、零后端依赖） */}
      <div className={styles.drawerSection}>
        <span className={styles.drawerSectionTitle}>
          {t('farm.telemetry.beaconBody.summaryTitle', { defaultValue: '指纹摘要（on-wire 自报）' })}
        </span>
        <div className={styles.fieldSpreadGrid} data-testid="farm-telemetry-drawer-summary">
          {/* 来源 */}
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

          {/* 顶层指纹字段（device_id 全量 / api_base_url_host / entrypoint / channel） */}
          {summaryRows.map((row) => (
            <FragmentRow key={row.key} label={row.label} value={row.value} hint={row.hint} />
          ))}

          {/* 采集时间 / host·path / 请求体大小 */}
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

      {/* 事件名（有才显） */}
      {eventNameCounts.length > 0 ? (
        <div className={styles.drawerSection}>
          <span className={styles.drawerSectionTitle}>
            {t('farm.telemetry.drawerEventNames', { defaultValue: '事件名（event_names）' })}
          </span>
          <div className={styles.eventNameChips} data-testid="farm-telemetry-drawer-events">
            {eventNameCounts.map(({ name, count }) => (
              <span key={name} className="status-badge muted">
                {name}
                {count > 1 ? (
                  <span className={detailStyles.eventNameCount}>
                    {t('farm.telemetry.jsonPreview.eventNameCount', {
                      defaultValue: '×{{count}}',
                      count,
                    })}
                  </span>
                ) : null}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {/* 请求体（脱敏）：默认不糊 raw。能 parse 的预览直接折叠树；截断的只给一行提示，
          原始 body 走「查看完整请求体」按需入口。见 <BeaconBodyView>。 */}
      <div className={styles.drawerSection}>
        <span className={styles.drawerSectionTitle}>
          {t('farm.telemetry.beaconBody.title', { defaultValue: '请求体（脱敏）' })}
        </span>
        {bodyPreview ? (
          <>
            <BeaconBodyView
              raw={bodyPreview}
              variant="preview"
              testId="farm-telemetry-drawer-body-preview"
            />

            {/* 「查看完整请求体」按需入口：仅当拿得到 beacon_id + containerId 时才提供
                （旧编排器缺 beacon_id 时不渲染按钮，仅保留上面的预览——优雅降级）。 */}
            {canLoadFullBody ? (
              <div
                className={detailStyles.fullBodyBlock}
                data-testid="farm-telemetry-drawer-full-body"
              >
                <button
                  type="button"
                  className={detailStyles.fullBodyToggle}
                  aria-expanded={showFullBody}
                  onClick={() => setShowFullBody((prev) => !prev)}
                  data-testid="farm-telemetry-drawer-full-body-toggle"
                >
                  {showFullBody
                    ? t('farm.telemetry.beaconBody.hideFull', { defaultValue: '收起完整请求体' })
                    : t('farm.telemetry.beaconBody.viewFull', { defaultValue: '查看完整请求体' })}
                </button>

                {showFullBody ? (
                  fullBodyLoading ? (
                    <span className={styles.hintText} data-testid="farm-telemetry-drawer-full-body-loading">
                      {t('farm.telemetry.beaconBody.fullLoading', { defaultValue: '正在加载完整请求体…' })}
                    </span>
                  ) : fullBodyError || !fullBody ? (
                    // fail-soft：完整 body 端点不可用（旧编排器无此端点 / 存储未装配 /
                    // 网络异常）时如实提示，不整页报错，摘要 + 预览仍在。
                    <span
                      className={styles.hintText}
                      data-testid="farm-telemetry-drawer-full-body-unavailable"
                    >
                      {t('farm.telemetry.beaconBody.fullUnavailable', {
                        defaultValue: '编排器暂不支持完整请求体（未提供该端点或查询失败），请参考上方预览。',
                      })}
                    </span>
                  ) : (
                    <BeaconBodyView
                      raw={fullBody.redacted_body}
                      variant="full"
                      safetyTruncated={fullBody.truncated}
                      testId="farm-telemetry-drawer-full-body-preview"
                    />
                  )
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <span className={styles.hintText}>
            {t('farm.telemetry.drawerNoBodyPreview', {
              defaultValue: '无请求体预览（该信标未携带可展示的 body，或编排器未提供该字段）。',
            })}
          </span>
        )}
      </div>

      {/* process_signal（进程退出信号，有才显） */}
      {ps ? (
        <div className={styles.drawerSection}>
          <span className={styles.drawerSectionTitle}>
            {t('farm.telemetry.drawerProcessSignal', { defaultValue: '进程退出信号（process_signal）' })}
          </span>
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
        </div>
      ) : null}
    </div>
  );
}

// reported_fields / 指纹摘要一行：label | value；空值显 '—'（诚实缺失）。masked=true 的
// 字段由服务端已脱敏，仅加 tooltip 说明；hint 用于非脱敏但需要口径说明的字段（如
// device_id 全量值）。
function FragmentRow({
  label,
  value,
  masked,
  hint,
}: {
  label: string;
  value: string;
  masked?: boolean;
  hint?: string;
}) {
  const { t } = useTranslation();
  const title = masked && value
    ? t('farm.telemetry.maskedHint', {
        defaultValue: '展示脱敏（前 12 + 后 4），完整值仅服务端保留',
      })
    : hint && value
      ? hint
      : undefined;
  return (
    <>
      <span className={styles.fieldSpreadLabel}>{label}</span>
      <span className={styles.fieldSpreadValue} title={title}>
        {value || '—'}
      </span>
    </>
  );
}

/**
 * 单段脱敏 body 的按需渲染（预览或完整）。核心目标：**永不成墙**。
 *   - 能 JSON.parse（对象/数组）→ react-json-view-lite 可折叠树；
 *   - parse 不了：
 *       · variant='preview'（预览被上游截断成非法 JSON）→ **不铺 raw**，只给一行中性
 *         提示引导「查看完整请求体」；
 *       · variant='full'（用户已显式点开完整 body，罕见非 JSON）→ on-demand 诚实展示
 *         只读原文（此时用户主动要看全文，不算默认糊墙）。
 * 工具条恒有「复制」按钮，复制**原始脱敏串**（不是美化后的），与后端脱敏一字不差。
 */
function BeaconBodyView({
  raw,
  variant,
  safetyTruncated,
  testId,
}: {
  raw: string;
  variant: 'preview' | 'full';
  safetyTruncated?: boolean;
  testId: string;
}) {
  const { t } = useTranslation();

  const parsed = useMemo<{ ok: true; data: object } | { ok: false }>(() => {
    try {
      const data: unknown = JSON.parse(raw);
      return data !== null && typeof data === 'object' ? { ok: true, data } : { ok: false };
    } catch {
      return { ok: false };
    }
  }, [raw]);

  const chars = raw.length;

  return (
    <div className={detailStyles.bodyView} data-testid={testId}>
      <div className={detailStyles.bodyToolbar}>
        <span className={detailStyles.bodySizeHint}>
          {variant === 'preview'
            ? t('farm.telemetry.beaconBody.previewSize', { defaultValue: '预览 · {{chars}} 字符', chars })
            : t('farm.telemetry.beaconBody.fullSize', { defaultValue: '完整 · {{chars}} 字符', chars })}
        </span>
        <CopyBodyButton text={raw} testId={`${testId}-copy`} />
      </div>

      {parsed.ok ? (
        <div className={detailStyles.jsonTree} data-testid={`${testId}-tree`}>
          <JsonView
            data={parsed.data}
            shouldExpandNode={variant === 'full' ? expandTelemetryBodyFull : expandTelemetryBodyPreview}
            clickToExpandNode
            style={JSON_TREE_STYLE}
          />
        </div>
      ) : variant === 'preview' ? (
        // 截断预览：不铺 raw 密文墙，一行中性提示引导看完整请求体。
        <span className={styles.hintText} data-testid={`${testId}-truncated-hint`}>
          {raw.endsWith(TRUNCATION_MARKER)
            ? t('farm.telemetry.beaconBody.previewTruncatedHint', {
                defaultValue: '预览已在约 {{chars}} 字符处截断（JSON 不完整无法结构化），点「查看完整请求体」看全文。',
                chars,
              })
            : t('farm.telemetry.beaconBody.previewNotJsonHint', {
                defaultValue: '预览不是结构化 JSON（约 {{chars}} 字符），点「查看完整请求体」或复制原文查看。',
                chars,
              })}
        </span>
      ) : (
        // 完整 body 罕见非 JSON：用户已显式点开、on-demand，诚实展示只读原文 + 复制。
        <pre className={detailStyles.rawBody} data-testid={`${testId}-raw`}>
          <code>{raw}</code>
        </pre>
      )}

      {safetyTruncated ? (
        <span className={styles.hintText} data-testid={`${testId}-safety-truncated`}>
          {t('farm.telemetry.beaconBody.safetyTruncated', {
            defaultValue: '完整请求体已在 64K 安全上限被裁（脱敏在完整原文完成，不影响脱敏完整性）。',
          })}
        </span>
      ) : null}
    </div>
  );
}

// 复制按钮：复制传入的原始脱敏串。成功后短暂显示「已复制」再自动回落（纯视觉反馈，
// 短生命周期抽屉内不做卸载清理——React 18 卸载后 setState 不再告警）。
function CopyBodyButton({ text, testId }: { text: string; testId?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <button
      type="button"
      className={detailStyles.copyButton}
      onClick={() => void onCopy()}
      data-testid={testId}
    >
      {copied
        ? t('farm.telemetry.beaconBody.copied', { defaultValue: '已复制' })
        : t('farm.telemetry.beaconBody.copy', { defaultValue: '复制' })}
    </button>
  );
}
