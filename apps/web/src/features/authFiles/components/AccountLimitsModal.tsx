import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useNotificationStore } from '@/stores';
import type { AuthFileItem, AuthFileAccountScheduling } from '@/types';
import { getAuthFilePatchTarget } from '../model/authFilesPageModel';
import { AccountPacingRecovery } from './AccountPacingRecovery';
import { AccountSchedulingPanel } from './AccountSchedulingPanel';
import styles from './WarmupPacing.module.scss';

/** 两个入口共用同一编辑器；保存只写当前账号，返回保留来源。 */
export function AccountLimitsModal({
  file,
  disabled,
  backLabel,
  onClose,
  onBack,
  onApplied,
}: {
  file: AuthFileItem;
  disabled?: boolean;
  backLabel: string;
  onClose: () => void;
  onBack: () => void;
  onApplied: (name: string, view: AuthFileAccountScheduling) => void;
}) {
  const { t } = useTranslation();
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const [formState, setFormState] = useState({ dirty: false, saving: false });
  const [saved, setSaved] = useState<{ view: AuthFileAccountScheduling; revision: number } | null>(
    null
  );
  const target = getAuthFilePatchTarget(file);
  const latest = useRef({ formState, onClose, onBack, showConfirmation, t });
  latest.current = { formState, onClose, onBack, showConfirmation, t };
  const leave = useCallback((back: boolean) => {
    const current = latest.current;
    if (current.formState.saving) return;
    const next = back ? current.onBack : current.onClose;
    if (!current.formState.dirty) return next();
    current.showConfirmation({
      title: current.t('auth_files.pacing.discard_title'),
      message: current.t('auth_files.pacing.discard_message'),
      confirmText: current.t('auth_files.pacing.discard_confirm'),
      cancelText: current.t('common.cancel'),
      onConfirm: next,
    });
  }, []);
  const close = useCallback(() => leave(false), [leave]);
  return (
    <Modal
      open
      onClose={close}
      closeDisabled={formState.saving}
      width={720}
      className={styles.dialogSurface}
      title={`${file.note || file.name} · ${t('auth_files.pacing.limits_title')}`}
    >
      <div data-testid="account-limits-editor" data-account-name={target.name}>
        <Button variant="ghost" size="sm" disabled={formState.saving} onClick={() => leave(true)}>
          {backLabel}
        </Button>
        <AccountPacingRecovery
          key={`recovery-${saved?.revision ?? 0}`}
          file={saved ? { ...file, account_scheduling: saved.view } : file}
        />
        {saved && <p role="status">{t('auth_files.pacing.saved_account_only')}</p>}
        <AccountSchedulingPanel
          key={`panel-${saved?.revision ?? 0}`}
          fileName={target.name}
          authIndex={target.authIndex}
          initialScheduling={saved?.view ?? file.account_scheduling}
          disabled={disabled}
          onStateChange={setFormState}
          onApplied={(view) => {
            setFormState({ dirty: false, saving: false });
            setSaved((old) => ({ view, revision: (old?.revision ?? 0) + 1 }));
            onApplied(target.name, view);
          }}
        />
      </div>
    </Modal>
  );
}
