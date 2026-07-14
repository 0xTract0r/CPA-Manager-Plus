import { useState, type ChangeEvent } from 'react';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import styles from '../MonitoringCenterPage.module.scss';

type CustomRangeMode = 'dateRange' | 'hours' | 'days';

type MonitoringCustomRangeModalProps = {
  open: boolean;
  startInput: string;
  endInput: string;
  error: string | null;
  t: TFunction;
  onClose: () => void;
  onApply: () => void;
  onStartChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onEndChange: (event: ChangeEvent<HTMLInputElement>) => void;
  /**
   * 快捷 preset chip：由调用方决定收纳在弹层内的额外档位(如"最近14天"/"全部")，
   * 点击后直接应用对应 preset 并关闭弹层，不需要经过日期范围表单。
   */
  quickPresets?: ReadonlyArray<{ value: string; label: string }>;
  onQuickPresetSelect?: (value: string) => void;
  /** 任意 N 小时快捷输入；应用后按 [now - N小时, now] 转换为日期范围提交。 */
  onApplyHours?: (hours: number) => void;
  /** 任意 N 天快捷输入；应用后按 [now - N天, now] 转换为日期范围提交。 */
  onApplyDays?: (days: number) => void;
};

const MODE_TABS: ReadonlyArray<{ mode: CustomRangeMode; labelKey: string }> = [
  { mode: 'hours', labelKey: 'monitoring.custom_mode_hours' },
  { mode: 'days', labelKey: 'monitoring.custom_mode_days' },
  { mode: 'dateRange', labelKey: 'monitoring.custom_mode_date_range' },
];

export function MonitoringCustomRangeModal({
  open,
  startInput,
  endInput,
  error,
  t,
  onClose,
  onApply,
  onStartChange,
  onEndChange,
  quickPresets,
  onQuickPresetSelect,
  onApplyHours,
  onApplyDays,
}: MonitoringCustomRangeModalProps) {
  const [mode, setMode] = useState<CustomRangeMode>('dateRange');
  const [hoursInput, setHoursInput] = useState('6');
  const [daysInput, setDaysInput] = useState('3');

  const hoursValue = Number(hoursInput);
  const hoursValid = Number.isFinite(hoursValue) && hoursValue > 0;
  const daysValue = Number(daysInput);
  const daysValid = Number.isFinite(daysValue) && daysValue > 0;

  const handleApply = () => {
    if (mode === 'hours' && onApplyHours) {
      if (!hoursValid) return;
      onApplyHours(hoursValue);
      return;
    }
    if (mode === 'days' && onApplyDays) {
      if (!daysValid) return;
      onApplyDays(daysValue);
      return;
    }
    onApply();
  };

  const applyDisabled =
    mode === 'dateRange' ? Boolean(error) : mode === 'hours' ? !hoursValid : !daysValid;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('monitoring.range_custom')}
      width={560}
      className={styles.monitorModal}
      footer={
        <div className={styles.customRangeModalFooter}>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={handleApply} disabled={applyDisabled}>
            {t('common.confirm')}
          </Button>
        </div>
      }
    >
      <div className={styles.customRangeModalBody}>
        {quickPresets && quickPresets.length > 0 ? (
          <div className={styles.customRangeQuickPresets}>
            {quickPresets.map((preset) => (
              <button
                key={preset.value}
                type="button"
                className={styles.customRangeQuickPresetButton}
                onClick={() => onQuickPresetSelect?.(preset.value)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className={styles.customRangeModeTabs} role="tablist">
          {MODE_TABS.map((tab) => (
            <button
              key={tab.mode}
              type="button"
              role="tab"
              aria-selected={mode === tab.mode}
              className={`${styles.customRangeModeTab} ${
                mode === tab.mode ? styles.customRangeModeTabActive : ''
              }`}
              onClick={() => setMode(tab.mode)}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>

        {mode === 'hours' ? (
          <div className={styles.customRangeQuickForm}>
            <Input
              type="number"
              min={1}
              max={8760}
              label={t('monitoring.custom_hours_label')}
              value={hoursInput}
              onChange={(event) => setHoursInput(event.target.value)}
              className={styles.customRangeInput}
              aria-invalid={!hoursValid}
            />
            {!hoursValid ? (
              <div className={styles.customRangeError} role="alert">
                {t('monitoring.custom_range_positive_number')}
              </div>
            ) : null}
          </div>
        ) : null}

        {mode === 'days' ? (
          <div className={styles.customRangeQuickForm}>
            <Input
              type="number"
              min={1}
              max={365}
              label={t('monitoring.custom_days_label')}
              value={daysInput}
              onChange={(event) => setDaysInput(event.target.value)}
              className={styles.customRangeInput}
              aria-invalid={!daysValid}
            />
            {!daysValid ? (
              <div className={styles.customRangeError} role="alert">
                {t('monitoring.custom_range_positive_number')}
              </div>
            ) : null}
          </div>
        ) : null}

        {mode === 'dateRange' ? (
          <>
            <div className={styles.customRangeModalGrid}>
              <Input
                type="datetime-local"
                label={t('monitoring.custom_range_start')}
                value={startInput}
                onChange={onStartChange}
                className={styles.customRangeInput}
                aria-invalid={Boolean(error)}
              />
              <Input
                type="datetime-local"
                label={t('monitoring.custom_range_end')}
                value={endInput}
                onChange={onEndChange}
                className={styles.customRangeInput}
                aria-invalid={Boolean(error)}
              />
            </div>
            {error ? (
              <div className={styles.customRangeError} role="alert">
                {error}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Modal>
  );
}
