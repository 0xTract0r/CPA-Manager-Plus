import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { IconEye, IconEyeOff } from '@/components/ui/icons';
import { useFarmStore, useNotificationStore } from '@/stores';
import styles from './FarmConfigPanel.module.scss';

/**
 * 农场编排器默认零配置：本组件是"高级覆盖"入口，只在 operator 需要直连另一个
 * 独立编排器实例时才使用——填了 base URL + admin key 才会切到覆盖模式；留空
 * 就是同源代理默认（farmClient 请求打相对路径 `/api/farm/*`，鉴权走 cpamp
 * 会话 managementKey，见 farmClient.ts 顶部注释）。保存后由 useFarmStore.setConfig
 * 灌进独立的 farmClient 单例。
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
  // 高级覆盖要么两者都填（切到直连别的编排器），要么两者都留空（退回同源代理
  // 默认）；只填其中一项是无效的中间态，禁止保存——不再要求"必须填齐才能保存"
  // 本身（那是旧的"连通前提"语义），清空两个字段同样是一次有效保存。
  const isPartialOverride = Boolean(trimmedBaseUrl) !== Boolean(trimmedAdminKey);
  const canSave = dirty && !isPartialOverride;

  const hasOverride = Boolean(orchestratorBaseUrl || farmAdminKey);
  const statusVariant = hasOverride && !isConfigured ? 'warning' : 'success';
  const statusLabel = hasOverride
    ? isConfigured
      ? t('farm.config.status_override_ready')
      : t('farm.config.status_override_error')
    : t('farm.config.status_same_origin');

  const handleSave = () => {
    setConfig({ orchestratorBaseUrl: trimmedBaseUrl, farmAdminKey: trimmedAdminKey });
    showNotification(t('farm.config.save_success'), 'success');
  };

  return (
    <div className={styles.panel} data-testid="farm-config-panel">
      <div className={styles.header}>
        <div className={styles.title}>{t('farm.config.title')}</div>
        <span
          className={`status-badge ${statusVariant}`}
          data-testid="farm-header-config-status"
        >
          {statusLabel}
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
      {isPartialOverride ? (
        <p className="error-box" data-testid="farm-config-partial-override-error">
          {t('farm.config.partial_override_error')}
        </p>
      ) : (
        !trimmedBaseUrl &&
        !trimmedAdminKey && <p className="hint">{t('farm.config.same_origin_hint')}</p>
      )}
      <div className={styles.actions}>
        <Button onClick={handleSave} disabled={!canSave} data-testid="farm-config-save">
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}
