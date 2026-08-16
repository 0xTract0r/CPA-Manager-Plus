import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { IconEye, IconEyeOff } from '@/components/ui/icons';
import { useFarmStore, useNotificationStore } from '@/stores';
import styles from './FarmConfigPanel.module.scss';

/**
 * 农场编排器是独立后端（services/farm-orchestrator），不走 CPA 登录页；
 * 这里是它唯一的配置入口——operator 手填编排器地址与 admin key，保存后
 * 由 useFarmStore.setConfig 灌进独立的 farmClient 单例（见 farmClient.ts）。
 */
export function FarmConfigPanel() {
  const { t } = useTranslation();
  const { showNotification } = useNotificationStore();
  const orchestratorBaseUrl = useFarmStore((state) => state.orchestratorBaseUrl);
  const farmAdminKey = useFarmStore((state) => state.farmAdminKey);
  const isConfigured = useFarmStore((state) => state.isConfigured);
  const setConfig = useFarmStore((state) => state.setConfig);

  const [baseUrlDraft, setBaseUrlDraft] = useState(orchestratorBaseUrl);
  const [adminKeyDraft, setAdminKeyDraft] = useState(farmAdminKey);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    setBaseUrlDraft(orchestratorBaseUrl);
  }, [orchestratorBaseUrl]);

  useEffect(() => {
    setAdminKeyDraft(farmAdminKey);
  }, [farmAdminKey]);

  const trimmedBaseUrl = baseUrlDraft.trim();
  const trimmedAdminKey = adminKeyDraft.trim();
  const dirty = trimmedBaseUrl !== orchestratorBaseUrl || trimmedAdminKey !== farmAdminKey;
  const canSave = Boolean(trimmedBaseUrl && trimmedAdminKey);

  const handleSave = () => {
    setConfig({ orchestratorBaseUrl: trimmedBaseUrl, farmAdminKey: trimmedAdminKey });
    showNotification(t('farm.config.save_success'), 'success');
  };

  return (
    <div className={styles.panel} data-testid="farm-config-panel">
      <div className={styles.header}>
        <div className={styles.title}>{t('farm.config.title')}</div>
        <span
          className={`status-badge ${isConfigured ? 'success' : 'warning'}`}
          data-testid="farm-header-config-status"
        >
          {isConfigured ? t('farm.config.status_ready') : t('farm.config.status_missing')}
        </span>
      </div>
      <p className={styles.desc}>{t('farm.config.desc')}</p>
      <div className={styles.fields}>
        <Input
          label={t('farm.config.base_url_label')}
          placeholder={t('farm.config.base_url_placeholder')}
          value={baseUrlDraft}
          onChange={(event) => setBaseUrlDraft(event.target.value)}
          data-testid="farm-config-base-url"
        />
        <Input
          label={t('farm.config.admin_key_label')}
          placeholder={t('farm.config.admin_key_placeholder')}
          type={showKey ? 'text' : 'password'}
          value={adminKeyDraft}
          onChange={(event) => setAdminKeyDraft(event.target.value)}
          data-testid="farm-config-admin-key"
          rightElement={
            <button
              type="button"
              className={styles.toggleVisibility}
              onClick={() => setShowKey((prev) => !prev)}
              aria-label={showKey ? t('farm.config.hide_key') : t('farm.config.show_key')}
              data-testid="farm-config-key-visibility-toggle"
            >
              {showKey ? <IconEyeOff size={16} /> : <IconEye size={16} />}
            </button>
          }
        />
      </div>
      <div className={styles.actions}>
        <Button onClick={handleSave} disabled={!canSave || !dirty} data-testid="farm-config-save">
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}
