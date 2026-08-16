import { useTranslation } from 'react-i18next';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { AsyncPanel } from '@/components/ui/AsyncPanel';
import { formatFileSize } from '@/utils/format';
import { useFarmResources } from '../hooks/useFarmResources';
import { pctToFarmHealthBadgeVariant } from '../utils/health';
import styles from './FarmResourcePanel.module.scss';

// 水位着色阈值：90/70 判定口径已收敛进 features/farm/utils/health.ts
// （pctToFarmHealthBadgeVariant），此处不再本地重复定义。

function formatPct(pct: number | undefined): string {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return '—';
  return `${pct.toFixed(1)}%`;
}

// 容器 MEMORY/LIMIT 兜底：cgroup 未显式设置内存上限时，Docker 会把 limit 报告成
// 宿主总内存（甚至更大），此时按数字原样展示会被误读成"这个容器的上限是
// 31.34GB"，严重误导。用 0（无 limit）或 ≈ 宿主总量（>= 98%，判定为"实际透传
// 宿主总量"）两种口径识别"没有真实 limit"，改为展示"no limit"文案而非数字，
// 且不画内存进度条（没有有意义的分母，画出来的百分比同样是误导）。
function hasRealLimit(memLimitBytes: number, hostMemTotalBytes: number | undefined): boolean {
  if (!memLimitBytes || memLimitBytes <= 0) return false;
  if (typeof hostMemTotalBytes === 'number' && hostMemTotalBytes > 0) {
    if (memLimitBytes >= hostMemTotalBytes * 0.98) return false;
  }
  return true;
}

// 细进度条：复用 pctToFarmHealthBadgeVariant 的颜色语义（success/warning/error/muted），无有效
// 百分比（如没有真实 limit）时不渲染。
function ResourceBar({
  pct,
  variant,
}: {
  pct: number | undefined;
  variant: 'success' | 'warning' | 'error' | 'muted';
}) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  const width = Math.min(100, Math.max(0, pct));
  return (
    <div className={styles.bar}>
      <div className={styles.barFill} data-variant={variant} style={{ width: `${width}%` }} />
    </div>
  );
}

/**
 * 资源占用面板：消费 GET /api/farm/resources（已绑定且 running 的农场容器
 * docker stats --no-stream 快照 + 整机资源水位）。host.note 固定携带
 * "整机含非农场进程"口径说明，原样展示，不另造措辞；取不到时后端已把数值
 * 字段回退为 0，这里不再臆造。
 */
export function FarmResourcePanel() {
  const { t } = useTranslation();
  const { containers, host, loading, error, reload } = useFarmResources();

  return (
    <div className={styles.panel} data-testid="farm-resource-panel">
      <div className={styles.header}>
        <div className={styles.title}>{t('farm.resources.title')}</div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => reload()}
          data-testid="farm-resources-refresh"
        >
          {t('common.refresh')}
        </Button>
      </div>

      <AsyncPanel
        loading={loading}
        error={error}
        loadingLabel={t('common.loading')}
        loadingTestId="farm-resources-loading"
        errorTestId="farm-resources-error"
      >
        <>
          {host ? (
            <div className={styles.hostRow} data-testid="farm-resource-host">
              <span className={styles.hostLabel}>{t('farm.resources.hostTitle')}</span>
              <span className={`status-badge ${pctToFarmHealthBadgeVariant(host.mem_pct)}`}>
                {t('farm.resources.mem')} {formatFileSize(host.mem_used_bytes)} /{' '}
                {formatFileSize(host.mem_total_bytes)} ({formatPct(host.mem_pct)})
              </span>
              <span className={styles.hostMeta}>
                load1 {host.load1.toFixed(2)} · {host.cpu_count} CPU
              </span>
              <ResourceBar pct={host.mem_pct} variant={pctToFarmHealthBadgeVariant(host.mem_pct)} />
              <p className={styles.note}>
                {t('farm.resources.hostNote', { defaultValue: host.note })}
              </p>
            </div>
          ) : null}

          {containers.length === 0 ? (
            <div data-testid="farm-resource-empty">
              <EmptyState
                title={t('farm.resources.empty', { defaultValue: 'No container resource data yet' })}
              />
            </div>
          ) : (
            <Table data-testid="farm-resource-table">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('farm.containers.column_device')}</TableHead>
                  <TableHead>{t('farm.accounts.column_name')}</TableHead>
                  <TableHead>
                    {t('farm.resources.mem')} / {t('farm.resources.limit')}
                  </TableHead>
                  <TableHead>{t('farm.resources.cpu')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {containers.map((item) => {
                  const memLimited = hasRealLimit(item.mem_limit_bytes, host?.mem_total_bytes);
                  const memVariant = memLimited ? pctToFarmHealthBadgeVariant(item.mem_pct) : 'muted';
                  const cpuVariant = pctToFarmHealthBadgeVariant(item.cpu_pct);
                  return (
                    <TableRow
                      key={item.container_id}
                      data-testid={`farm-resource-row-${item.container_id}`}
                    >
                      <TableCell data-label={t('farm.containers.column_device')}>
                        <span className={styles.mono}>{item.container_id}</span>
                      </TableCell>
                      <TableCell data-label={t('farm.accounts.column_name')}>
                        {item.account_id}
                      </TableCell>
                      <TableCell
                        data-label={`${t('farm.resources.mem')} / ${t('farm.resources.limit')}`}
                      >
                        <div className={styles.metricCell}>
                          <span className={`status-badge ${memVariant}`}>
                            {formatFileSize(item.mem_used_bytes)} /{' '}
                            {memLimited
                              ? `${formatFileSize(item.mem_limit_bytes)} (${formatPct(item.mem_pct)})`
                              : t('farm.resources.noLimit', { defaultValue: 'no limit' })}
                          </span>
                          {memLimited ? (
                            <ResourceBar pct={item.mem_pct} variant={memVariant} />
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell data-label={t('farm.resources.cpu')}>
                        <div className={styles.metricCell}>
                          <span className={`status-badge ${cpuVariant}`}>
                            {formatPct(item.cpu_pct)}
                          </span>
                          <ResourceBar pct={item.cpu_pct} variant={cpuVariant} />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </>
      </AsyncPanel>
    </div>
  );
}
