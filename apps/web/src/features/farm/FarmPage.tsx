/**
 * 农场页（Device Farm）迁移到 cpamp — 第一刀：数据层 + 路由 + 打通。
 *
 * 本刀只做「能渲染的最小版」：连接状态条 + 独立编排器配置表单 + 调 farm API 拉
 * 容器列表并基本渲染。农场编排器是独立后端（独立 base URL + 独立 admin key，
 * 见 services/api/farmClient.ts），刻意不接 CPA managementKey / apiClient，
 * 编排器 401 不会把 cpamp 管理会话登出。
 *
 * 精修（KPI 概览带、告警面板、容器详情抽屉、绑定/退役/onboard 操作、时区/图表
 * 等）留后续切片；FarmDashboard 等 apps/web 组件按 cpamp 设计系统重做，不在本刀。
 */

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useFarmStore } from '@/stores';
import { useFarmContainers } from '@/features/farm/hooks/useFarmContainers';
import styles from './FarmPage.module.scss';

type ConnectionState = 'not-configured' | 'connecting' | 'connected' | 'error';

function formatTimestamp(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function FarmPage() {
  const orchestratorBaseUrl = useFarmStore((state) => state.orchestratorBaseUrl);
  const farmAdminKey = useFarmStore((state) => state.farmAdminKey);
  const isConfigured = useFarmStore((state) => state.isConfigured);
  const setConfig = useFarmStore((state) => state.setConfig);
  const clearConfig = useFarmStore((state) => state.clearConfig);

  const [baseUrlInput, setBaseUrlInput] = useState(orchestratorBaseUrl);
  const [adminKeyInput, setAdminKeyInput] = useState(farmAdminKey);

  const { containers, loading, error, reload } = useFarmContainers();

  const connectionState: ConnectionState = !isConfigured
    ? 'not-configured'
    : error
      ? 'error'
      : loading
        ? 'connecting'
        : 'connected';

  const statusMeta: Record<ConnectionState, { dot: string; text: string; detail: string }> = {
    'not-configured': {
      dot: styles.statusDot,
      text: '未配置',
      detail: '填写编排器地址与 admin key 后连接',
    },
    connecting: {
      dot: `${styles.statusDot} ${styles.statusConnecting}`,
      text: '连接中',
      detail: orchestratorBaseUrl,
    },
    connected: {
      dot: `${styles.statusDot} ${styles.statusConnected}`,
      text: '已连接',
      detail: `${orchestratorBaseUrl} · ${containers.length} 个容器`,
    },
    error: {
      dot: `${styles.statusDot} ${styles.statusError}`,
      text: '连接异常',
      detail: error || '编排器请求失败',
    },
  };
  const status = statusMeta[connectionState];

  const handleConnect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setConfig({ orchestratorBaseUrl: baseUrlInput, farmAdminKey: adminKeyInput });
  };

  const handleDisconnect = () => {
    clearConfig();
    setBaseUrlInput('');
    setAdminKeyInput('');
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.pageTitle}>农场</h1>
        <p className={styles.subtitle}>Device Farm 编排器容器池（迁移第一刀：数据层已打通，界面精修留后续）</p>
      </div>

      <div className={styles.statusBar} data-testid="farm-connection-status">
        <span className={status.dot} aria-hidden="true" />
        <span className={styles.statusText}>{status.text}</span>
        <span className={styles.statusDetail}>{status.detail}</span>
        <span className={styles.statusSpacer} />
        {isConfigured && (
          <Button variant="ghost" size="sm" onClick={() => void reload()} disabled={loading}>
            刷新
          </Button>
        )}
      </div>

      <Card title="编排器连接">
        <form className={styles.configForm} onSubmit={handleConnect}>
          <Input
            label="编排器地址（Base URL）"
            placeholder="http://10.1.1.201:18080"
            value={baseUrlInput}
            onChange={(event) => setBaseUrlInput(event.target.value)}
            autoComplete="off"
          />
          <Input
            label="Farm Admin Key"
            type="password"
            placeholder="FARM_MGMT_KEY"
            value={adminKeyInput}
            onChange={(event) => setAdminKeyInput(event.target.value)}
            autoComplete="off"
          />
          <div className={styles.configActions}>
            <Button type="submit" variant="primary" size="sm">
              {isConfigured ? '更新连接' : '连接'}
            </Button>
            {isConfigured && (
              <Button type="button" variant="ghost" size="sm" onClick={handleDisconnect}>
                断开
              </Button>
            )}
          </div>
        </form>
      </Card>

      <Card title="容器池">
        {!isConfigured ? (
          <EmptyState
            title="尚未连接编排器"
            description="填写上方编排器地址与 admin key 后即可加载农场容器池。"
          />
        ) : loading && containers.length === 0 ? (
          <LoadingSpinner />
        ) : error ? (
          <EmptyState
            title="加载失败"
            description={error}
            action={
              <Button variant="secondary" size="sm" onClick={() => void reload()}>
                重试
              </Button>
            }
          />
        ) : containers.length === 0 ? (
          <EmptyState title="暂无容器" description="编排器当前没有活跃容器。" />
        ) : (
          <div className={styles.table} role="table" aria-label="农场容器列表">
            <div className={styles.tableHeader} role="row">
              <span className={styles.cell} role="columnheader">
                容器 ID
              </span>
              <span className={styles.cell} role="columnheader">
                状态
              </span>
              <span className={styles.cell} role="columnheader">
                device_id
              </span>
              <span className={styles.cell} role="columnheader">
                绑定账号
              </span>
              <span className={styles.cell} role="columnheader">
                最近保活
              </span>
            </div>
            {containers.map((container) => (
              <div className={styles.tableRow} role="row" key={container.id}>
                <span className={`${styles.cell} ${styles.mono}`} role="cell" title={container.id}>
                  {container.id}
                </span>
                <span className={styles.cell} role="cell">
                  <span className={styles.badge}>{container.status}</span>
                </span>
                <span className={`${styles.cell} ${styles.mono}`} role="cell">
                  {container.device_id_masked || '—'}
                </span>
                <span className={styles.cell} role="cell">
                  {container.binding
                    ? `${container.binding.account} (${container.binding.env})`
                    : '未绑定'}
                </span>
                <span className={styles.cell} role="cell">
                  {formatTimestamp(container.last_keepalive_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
