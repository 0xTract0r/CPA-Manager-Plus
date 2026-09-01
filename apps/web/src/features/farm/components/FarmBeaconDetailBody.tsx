import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { JsonPreview } from '@/components/ui/JsonPreview';
import { useTimezone } from '@/hooks/useTimezone';
import { resolveBeaconSourceKind, type FarmContainerBeaconView } from '@/types/farm';
import { formatDateTimeUtc8 } from '@/utils/datetime';
import { formatFileSize } from '@/utils/format';
import { useFarmBeaconRedactedBody } from '../hooks/useFarmContainerBeacons';
import detailStyles from './FarmBeaconDetailBody.module.scss';
import styles from './FarmTelemetryPanel.module.scss';

/**
 * 信标详情抽屉正文：展示单条 beacon 的完整上报内容——概要 + reported_fields（脱敏）+
 * 事件名 + body_preview（脱敏预览）+ process_signal（进程退出信号，null 时诚实标注
 * 无信号且不代表进程还活着）。只展示脱敏值，不解析原始 body，不编造缺失字段。
 *
 * 从 FarmTelemetryPanel 抽出（farm-proxy-rotation Change B Foundation §6 独占本文件），
 * 与 §5 指纹卡所在的 FarmTelemetryPanel 拆开以便后续组件切片文件不相交并行；抽取过程
 * **零行为改动**，仅移动 + 接好依赖，渲染逻辑逐字保持不变。
 *
 * §6 正式切片在抽取基础上补了两处结构化 UX（不影响其余 section 的渲染逻辑）：
 * body_preview 从纯 `<pre>` 换成 <JsonPreview>（安全美化 + 轻着色 + 可折叠 +
 * 复用 reportedRows 同款脱敏口径识别 `***REDACTED***` 渲成 pill + 截断兜底回原文，
 * 见该组件文件头注释）；event_names 从逐条 chip 改「去重 + 按出现频次排序 + ×N
 * 计数」，避免同一事件名重复上报时把详情抽屉刷成一长串重复 chip。
 */
export function BeaconDetailBody({
  beacon,
  containerId,
}: {
  beacon: FarmContainerBeaconView;
  // 承载该 beacon 的容器 id（FarmTelemetryPanel 下传）：调「看完整 body」端点必需。
  // null（理论上抽屉打开时不会发生）时「看完整 body」入口优雅降级为不可用。
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

  // 「看完整 body」按需展开态：默认收起，只展示有界截断预览；点开才调
  // GET .../beacons/{beaconID}/redacted-body 取完整脱敏 body（用户③）。beacon_id 缺失
  // （旧编排器）或无容器 id 时，入口不可用（不渲染按钮），仅保留截断预览——优雅降级。
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

  // 事件名去重 + 按出现频次降序排序（同频次保留首次出现顺序——Map 按插入顺序
  // 迭代 + Array.sort 是稳定排序，二者叠加天然满足）。只做计数展示，不改变
  // eventNames 本身承载的语义（仍是服务端逐条上报的原始事件名）。
  const eventNameCounts: Array<{ name: string; count: number }> = (() => {
    const counts = new Map<string, number>();
    for (const name of eventNames) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  })();

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
        {eventNameCounts.length > 0 ? (
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
        ) : (
          <span className={styles.hintText}>
            {t('farm.telemetry.drawerNoEventNames', {
              defaultValue: '该信标无事件名（仅 event_logging / datadog_logs 通道会带）。',
            })}
          </span>
        )}
      </div>

      {/* body_preview（脱敏预览）：结构化展示，见 <JsonPreview> 文件头注释——安全
          美化 + 轻着色 + 可折叠 + 复用同一套脱敏占位符识别渲成 pill + 截断兜底回原文，
          不解析请求体业务语义。真实预览/总字符数由 JsonPreview 动态行显示，标题不写死
          具体字符上限（后端预览上限已可配）。想看完整脱敏 body 走下方「看完整 body」
          按需入口（GET .../beacons/{beaconID}/redacted-body）。 */}
      <div className={styles.drawerSection}>
        <span className={styles.drawerSectionTitle}>
          {t('farm.telemetry.drawerBodyPreview', { defaultValue: '请求体预览（脱敏）' })}
        </span>
        {bodyPreview ? (
          <>
            <JsonPreview
              value={bodyPreview}
              totalBytes={beacon.body_bytes}
              ariaLabel={t('farm.telemetry.drawerBodyPreview', {
                defaultValue: '请求体预览（脱敏）',
              })}
              testId="farm-telemetry-drawer-body-preview"
            />

            {/* 「看完整 body」按需入口：仅当拿得到 beacon_id + containerId 时才提供
                （旧编排器缺 beacon_id 时不渲染按钮，仅保留上面的截断预览——优雅降级）。 */}
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
                    ? t('farm.telemetry.fullBody.hide', { defaultValue: '收起完整 body' })
                    : t('farm.telemetry.fullBody.show', { defaultValue: '看完整 body' })}
                </button>

                {showFullBody ? (
                  fullBodyLoading ? (
                    <span className={styles.hintText} data-testid="farm-telemetry-drawer-full-body-loading">
                      {t('farm.telemetry.fullBody.loading', { defaultValue: '正在加载完整 body…' })}
                    </span>
                  ) : fullBodyError || !fullBody ? (
                    // 优雅降级：完整 body 端点不可用（旧编排器无此端点 / 存储未装配 /
                    // 网络异常）时如实提示，不整页报错，上方截断预览仍在。
                    <span
                      className={styles.hintText}
                      data-testid="farm-telemetry-drawer-full-body-unavailable"
                    >
                      {t('farm.telemetry.fullBody.unavailable', {
                        defaultValue:
                          '完整 body 暂不可用（编排器未提供该端点或查询失败），请参考上方截断预览。',
                      })}
                    </span>
                  ) : (
                    <>
                      <JsonPreview
                        value={fullBody.redacted_body}
                        totalBytes={fullBody.total_bytes}
                        ariaLabel={t('farm.telemetry.fullBody.ariaLabel', {
                          defaultValue: '完整请求体（脱敏）',
                        })}
                        testId="farm-telemetry-drawer-full-body-preview"
                      />
                      {fullBody.truncated ? (
                        <span
                          className={styles.hintText}
                          data-testid="farm-telemetry-drawer-full-body-safety-truncated"
                        >
                          {t('farm.telemetry.fullBody.safetyTruncated', {
                            defaultValue: '完整 body 已达 64K 安全上限被裁（脱敏在完整原文完成，不影响脱敏完整性）。',
                          })}
                        </span>
                      ) : null}
                    </>
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
