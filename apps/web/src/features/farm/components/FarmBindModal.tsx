import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { AsyncPanel } from '@/components/ui/AsyncPanel';
import { useFarmAccounts } from '../hooks/useFarmAccounts';
import type { FarmContainerView, FarmCreateBindingRequest, FarmEnv } from '@/types/farm';
import { FARM_ENVS } from '@/types/farm';
import styles from './FarmBindModal.module.scss';

interface FarmBindModalProps {
  open: boolean;
  submitting: boolean;
  containers: FarmContainerView[];
  preselectedContainerId?: string | null;
  onClose: () => void;
  onSubmit: (request: FarmCreateBindingRequest) => Promise<void>;
}

/**
 * 手动绑定弹窗：挑未绑定容器 + 选环境 + 选该环境下的账号，提交
 * POST /api/farm/bindings。绑定是排他的（handlers.go handleCreateBinding：
 * 容器已绑/账号已在该 env 绑过都会 409），弹窗本身只负责收集入参，冲突交
 * 后端拒绝、由调用方 toast 报错。
 */
export function FarmBindModal({
  open,
  submitting,
  containers,
  preselectedContainerId,
  onClose,
  onSubmit,
}: FarmBindModalProps) {
  const { t } = useTranslation();
  const [containerId, setContainerId] = useState('');
  const [env, setEnv] = useState<FarmEnv>('test');
  const [accountId, setAccountId] = useState('');

  const unboundContainers = useMemo(() => containers.filter((c) => !c.binding), [containers]);
  const { accounts, loading: accountsLoading } = useFarmAccounts(env);
  const availableAccounts = useMemo(() => accounts.filter((a) => !a.disabled), [accounts]);

  useEffect(() => {
    if (!open) return;
    setContainerId(
      preselectedContainerId && unboundContainers.some((c) => c.id === preselectedContainerId)
        ? preselectedContainerId
        : (unboundContainers[0]?.id ?? '')
    );
    setEnv('test');
    setAccountId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preselectedContainerId]);

  useEffect(() => {
    if (!accountId) return;
    if (!availableAccounts.some((a) => a.name === accountId)) {
      setAccountId('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableAccounts]);

  const containerOptions = unboundContainers.map((c) => ({
    value: c.id,
    label: `${c.id} (${c.device_id_masked})`,
  }));
  const envOptions = FARM_ENVS.map((value) => ({ value, label: t(`farm.env.${value}`) }));
  const accountOptions = availableAccounts.map((a) => ({
    value: a.name,
    label: a.status ? `${a.name} · ${a.status}` : a.name,
  }));

  const canSubmit = Boolean(containerId && env && accountId) && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    await onSubmit({ container_id: containerId, account_id: accountId, env });
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('farm.bind_modal.title')}
      closeDisabled={submitting}
      className={styles.modal}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={onClose}
            disabled={submitting}
            data-testid="farm-bind-modal-cancel"
          >
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            loading={submitting}
            disabled={!canSubmit}
            data-testid="farm-bind-modal-submit"
          >
            {t('farm.bind_modal.submit')}
          </Button>
        </>
      }
    >
      <div className={styles.body} data-testid="farm-bind-modal">
        {unboundContainers.length === 0 ? (
          <div className="hint">{t('farm.bind_modal.no_unbound_containers')}</div>
        ) : (
          <div className="form-group" data-testid="farm-bind-modal-container">
            <label>{t('farm.bind_modal.container_label')}</label>
            <Select
              value={containerId}
              options={containerOptions}
              onChange={setContainerId}
              placeholder={t('farm.bind_modal.container_placeholder')}
              ariaLabel={t('farm.bind_modal.container_label')}
            />
          </div>
        )}

        <div className="form-group" data-testid="farm-bind-modal-env-select">
          <label>{t('farm.bind_modal.env_label')}</label>
          <Select
            value={env}
            options={envOptions}
            onChange={(value) => setEnv(value as FarmEnv)}
            ariaLabel={t('farm.bind_modal.env_label')}
          />
        </div>

        <div className="form-group" data-testid="farm-bind-modal-account-select">
          <label>{t('farm.bind_modal.account_label')}</label>
          <AsyncPanel
            loading={accountsLoading}
            isEmpty={accountOptions.length === 0}
            loadingLabel={t('common.loading')}
            empty={{ title: t('farm.bind_modal.no_accounts'), compact: true }}
          >
            <Select
              value={accountId}
              options={accountOptions}
              onChange={setAccountId}
              placeholder={t('farm.bind_modal.account_placeholder')}
              ariaLabel={t('farm.bind_modal.account_label')}
            />
          </AsyncPanel>
        </div>
      </div>
    </Modal>
  );
}
