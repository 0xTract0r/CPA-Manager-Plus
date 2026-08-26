import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTimezone } from '@/hooks/useTimezone';
import { AsyncPanel } from '@/components/ui/AsyncPanel';
import { HealthPill } from '@/components/ui/HealthPill';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import { farmApi } from '@/services/api/farm';
import type { FarmContainerView, FarmEnv, FarmIdentityLineageRecord } from '@/types/farm';
import { formatDateTimeUtc8 } from '@/utils/datetime';
import { ResponsiveTable } from './ResponsiveTable';
import styles from './FarmContainerDetail.module.scss';

// bindingEnv 是原始 string（container.binding?.env），未绑定时缺失；与
// useFarmContainerDetail.ts 的同名本地校验逐字一致——只接受 test/prod 两个合法
// 值，非法/缺失值一律归一为 undefined（查询不限 env），不把非法值传给后端。
function isFarmEnv(value: string | undefined): value is FarmEnv {
  return value === 'test' || value === 'prod';
}

interface FarmIdentityLineagePanelProps {
  /**
   * 目标容器（详情聚合视图，与 <FarmTelemetryPanel> 同款 container prop 传参口径）。
   * 谱系查询主键是**账号**而非容器：优先取当前绑定 `binding.account`（原始未脱敏
   * 标识，与 resolveBindingIdentity 全站取值口径一致，供 query 使用——展示层只吐
   * 后端已脱敏字段，不在前端二次脱敏/也不解脱），当前未绑定时回退
   * `last_bound_account`（该容器解绑前最后绑定过的账号，同样能查到历史谱系）。
   * 两者都缺失（容器从未绑定过任何账号）时没有可查询的账号，诚实渲染空态、不发请求。
   */
  container: FarmContainerView | null;
}

/**
 * §3 身份/代理变更历史区（farm-proxy-rotation SURV1「持久化身份谱系」）：某账号
 * device_id / 代理 / 出口 IP 的脱敏时间线（GET /api/farm/identity-lineage，
 * identity_lineage.go），append-only 审计账本，按 start_at 降序（后端已排序，本
 * 组件原样透传，不重排）。附带 cross_ip_reuse_detected 审计结论——「同一
 * device_id 曾出现在两个不同住宅出口」，反关联不变量（D1：每次换 IP 必换
 * device_id）被破坏的信号，正常系统恒 false；本面板把它做成显著横幅高亮，而不是
 * 埋进表格某一格。
 *
 * 谱系存储未装配、或该账号尚无记录时，后端优雅退化为空历史（不 500）——本面板
 * 对「无账号可查」与「查了但没有记录」统一走同一个诚实空态（两者本质都是「当前
 * 没有谱系记录可展示」，没有为区分二者臆造额外文案）。
 */
export function FarmIdentityLineagePanel({ container }: FarmIdentityLineagePanelProps) {
  const { t, i18n } = useTranslation();
  // 订阅全局时区（TZ2/#49）：切换时区时本组件重渲染，内部 formatDateTimeUtc8 同步刷新。
  useTimezone();

  const account = container?.binding?.account || container?.last_bound_account || '';
  const rawEnv = container?.binding?.env;
  const env = isFarmEnv(rawEnv) ? rawEnv : undefined;

  const [records, setRecords] = useState<FarmIdentityLineageRecord[]>([]);
  const [crossIpReuseDetected, setCrossIpReuseDetected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!account) {
      // 没有可查询的账号（容器从未绑定过）：诚实清空，不发请求。
      setRecords([]);
      setCrossIpReuseDetected(false);
      setError('');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    farmApi
      .getIdentityLineage(account, env)
      .then((res) => {
        // 防御性校验响应形状，异常时按空历史处理而非崩溃（与
        // useFarmContainerBeacons 同款取舍）。
        setRecords(Array.isArray(res?.epochs) ? res.epochs : []);
        setCrossIpReuseDetected(Boolean(res?.cross_ip_reuse_detected));
      })
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        setRecords([]);
        setCrossIpReuseDetected(false);
        setError(
          t('farm.lineage.error', {
            message,
            defaultValue: `加载身份谱系失败：${message}`,
          })
        );
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, env]);

  const reasonLabel = (reason: string) =>
    t(`farm.lineage.reason_${reason}`, { defaultValue: reason || '—' });
  const endReasonLabel = (endReason: string | undefined) =>
    endReason
      ? t(`farm.lineage.endReason_${endReason}`, { defaultValue: endReason })
      : t('farm.lineage.ongoing', { defaultValue: 'Ongoing' });

  // 审计横幅只在「确实成功查询过该账号」时展示——避免 loading/error 中间态或
  // 尚未查询时用初始值 false 误显「审计通过」。
  const showAuditBanner = Boolean(account) && !loading && !error;

  return (
    <div data-testid="farm-lineage-panel">
      <section className={styles.section} data-testid="farm-lineage-section">
        <h3 className={styles.sectionTitle}>
          {t('farm.lineage.title', { defaultValue: '身份 / 代理变更历史' })}
        </h3>

        {showAuditBanner ? (
          <div data-testid="farm-lineage-cross-ip-audit">
            <div className={styles.healthRow}>
              <HealthPill
                status={crossIpReuseDetected ? 'err' : 'ok'}
                label={t('farm.lineage.crossIpTitle', { defaultValue: '跨 IP 复用审计' })}
                data-testid="farm-lineage-cross-ip-pill"
              />
            </div>
            <p className={styles.reasonText} data-testid="farm-lineage-cross-ip-detail">
              {crossIpReuseDetected
                ? t('farm.lineage.crossIpWarning', {
                    defaultValue:
                      '反关联不变量被破坏：同一 device_id 曾出现在两个不同住宅出口。每次换 IP 都必须换 device_id——请立即排查。',
                  })
                : t('farm.lineage.crossIpNone', {
                    defaultValue: '审计通过：该 device_id 从未在不同住宅出口间复用。',
                  })}
            </p>
          </div>
        ) : null}

        <AsyncPanel
          loading={loading}
          error={error}
          isEmpty={records.length === 0}
          loadingLabel={t('farm.lineage.loading', { defaultValue: '身份谱系加载中…' })}
          loadingTestId="farm-lineage-loading"
          errorTestId="farm-lineage-error"
          empty={{
            title: t('farm.lineage.empty', { defaultValue: '该账号暂无身份谱系记录。' }),
            testId: 'farm-lineage-empty',
          }}
          dataTestId="farm-lineage-data"
        >
          <ResponsiveTable breakpoint="farm-tablet">
            <Table data-testid="farm-lineage-table">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('farm.lineage.colDeviceId', { defaultValue: 'device_id' })}</TableHead>
                  <TableHead>{t('farm.lineage.colProxy', { defaultValue: '代理' })}</TableHead>
                  <TableHead>{t('farm.lineage.colEgressIp', { defaultValue: '出口 IP' })}</TableHead>
                  <TableHead>{t('farm.lineage.colStartAt', { defaultValue: '开始' })}</TableHead>
                  <TableHead>{t('farm.lineage.colEndAt', { defaultValue: '结束' })}</TableHead>
                  <TableHead>{t('farm.lineage.colReason', { defaultValue: '原因' })}</TableHead>
                  <TableHead>{t('farm.lineage.colEndReason', { defaultValue: '结束原因' })}</TableHead>
                  <TableHead>{t('farm.lineage.colOperator', { defaultValue: '操作人' })}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((record, idx) => (
                  <TableRow
                    key={`${record.container_id}-${record.start_at}-${idx}`}
                    data-testid={`farm-lineage-row-${idx}`}
                    data-current={record.current ? 'true' : 'false'}
                  >
                    <TableCell className={styles.mono}>
                      {record.device_id_masked}
                      {record.current ? (
                        <span style={{ marginLeft: 8, display: 'inline-block' }}>
                          <HealthPill
                            status="ok"
                            label={t('farm.lineage.current', { defaultValue: '当前' })}
                            data-testid={`farm-lineage-current-badge-${idx}`}
                          />
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className={styles.mono}>{record.proxy_masked || '—'}</TableCell>
                    <TableCell className={styles.mono}>{record.egress_ip || '—'}</TableCell>
                    <TableCell>{formatDateTimeUtc8(record.start_at, i18n.language)}</TableCell>
                    <TableCell>
                      {record.end_at
                        ? formatDateTimeUtc8(record.end_at, i18n.language)
                        : t('farm.lineage.ongoing', { defaultValue: 'Ongoing' })}
                    </TableCell>
                    <TableCell>{reasonLabel(record.reason)}</TableCell>
                    <TableCell>{endReasonLabel(record.end_reason)}</TableCell>
                    <TableCell>{record.operator || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ResponsiveTable>
        </AsyncPanel>

        <p className={styles.hintText} data-testid="farm-lineage-masked-hint">
          {t('farm.lineage.maskedHint', {
            defaultValue: 'device_id / 代理均已脱敏展示（前 12 + 后 4 位），完整值仅存于服务端。',
          })}
        </p>
      </section>
    </div>
  );
}
