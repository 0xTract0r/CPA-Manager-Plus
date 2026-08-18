import { useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { FarmContainerView } from '@/types/farm';
import {
  FarmContainerDetailContent,
  type FarmDetailTab,
} from '../components/FarmContainerDetailContent';
import { useFarmContainers } from '../hooks/useFarmContainers';
import { resolveBindingIdentity } from '../utils/identity';
import { FarmSubPage } from './FarmSubPage';
import styles from './FarmContainerDetailPage.module.scss';

const VALID_TABS: readonly FarmDetailTab[] = [
  'overview',
  'telemetry',
  'resources',
  'cadence',
  'events',
];

function normalizeTab(raw: string | null): FarmDetailTab {
  return raw && (VALID_TABS as readonly string[]).includes(raw) ? (raw as FarmDetailTab) : 'overview';
}

/**
 * 账号·设备详情独立整页（/farm/containers/:id）。原为覆盖在容器池 / 账号表之上的
 * 抽屉，重构为独立路由页，顶部「返回容器池」回到 /farm/containers。5 分区内容
 * （概览 / 遥测 / 资源 / 节奏与用量 / 事件）复用 FarmContainerDetailContent；
 * ?tab= 查询参数深链到指定分区（账号页遥测入口带 ?tab=telemetry）。
 */
export function FarmContainerDetailPage() {
  const { t } = useTranslation();
  const { id: rawId } = useParams<{ id: string }>();
  const id = rawId ?? '';
  const [searchParams] = useSearchParams();
  const initialTab = normalizeTab(searchParams.get('tab'));

  // 从活跃容器列表定位该容器（用于页头标识 + 缩用量查询 env）。点击行进入时列表
  // 已加载、必命中；深链/刷新直达时首帧可能未命中，仍用最小占位容器让详情内容
  // 按 id 独立拉取（useFarmContainerDetail 走 /api/farm/containers/{id}），列表轮询
  // 到位后页头标识自然补全。
  const { containers } = useFarmContainers();
  const found = useMemo(() => containers.find((c) => c.id === id), [containers, id]);
  const container: FarmContainerView = found ?? {
    id,
    device_id_masked: '',
    status: '',
    created_at: '',
    updated_at: '',
  };

  const bindingIdentity = found?.binding
    ? resolveBindingIdentity(found.binding.note, found.binding.account)
    : null;

  const subtitle = (
    <span className={styles.identityLine}>
      <span className={styles.identityAccount}>
        {bindingIdentity?.primary ||
          t('farm.detail.titleAccountUnbound', { defaultValue: '未绑定账号' })}
      </span>
      {container.device_id_masked ? (
        <span className={styles.identityMasked}>{container.device_id_masked}</span>
      ) : null}
      <span className={styles.identityId}>{container.id}</span>
    </span>
  );

  return (
    <FarmSubPage
      title={t('farm.detail.titleLabel', { defaultValue: '账号 · 设备详情' })}
      subtitle={subtitle}
      backLink={{ to: '/farm/containers', label: t('farm.ia.backToContainers') }}
      testId="farm-container-detail-page"
    >
      <FarmContainerDetailContent container={container} initialTab={initialTab} />
    </FarmSubPage>
  );
}
