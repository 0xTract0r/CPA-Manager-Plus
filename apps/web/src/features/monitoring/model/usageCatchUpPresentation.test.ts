import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import type { UsageCatchUpRunStatus } from '@/services/api/usageService';
import { presentUsageCatchUpStatus } from './usageCatchUpPresentation';

// 简化的 i18next TFunction 假实现：无预置翻译时回退 defaultValue，并做
// {{key}} 插值替换，足以驱动 presentUsageCatchUpStatus 的行为。
const t = ((key: string, options?: Record<string, unknown>) => {
  const template = options && typeof options.defaultValue === 'string' ? options.defaultValue : key;
  if (!options) return template;
  return Object.entries(options).reduce(
    (value, [name, replacement]) =>
      name === 'defaultValue' ? value : value.replace(`{{${name}}}`, String(replacement)),
    template
  );
}) as TFunction;

const baseStatus: UsageCatchUpRunStatus = {
  lastRunAtMs: Date.UTC(2026, 0, 1, 12, 0, 0),
  lastAdded: 12,
  lastStatus: 'ok',
  totalAdded: 4821,
  trigger: 'timer',
};

describe('presentUsageCatchUpStatus', () => {
  it('returns null when found is false', () => {
    expect(presentUsageCatchUpStatus(false, baseStatus, 'zh-CN', t)).toBeNull();
  });

  it('returns null when status is null even if found is true', () => {
    expect(presentUsageCatchUpStatus(true, null, 'zh-CN', t)).toBeNull();
  });

  it('maps ok status to good tone and includes added count', () => {
    const result = presentUsageCatchUpStatus(true, baseStatus, 'en-US', t);
    expect(result).not.toBeNull();
    expect(result?.tone).toBe('good');
    expect(result?.label).toContain('12');
    expect(result?.title).toContain('4821');
  });

  it('maps error status to bad tone and surfaces lastError in the title', () => {
    const errored: UsageCatchUpRunStatus = {
      ...baseStatus,
      lastStatus: 'error',
      lastError: 'core unreachable',
      lastAdded: 0,
    };
    const result = presentUsageCatchUpStatus(true, errored, 'en-US', t);
    expect(result?.tone).toBe('bad');
    expect(result?.title).toContain('core unreachable');
  });

  it('maps nodata status to warn tone', () => {
    const nodata: UsageCatchUpRunStatus = { ...baseStatus, lastStatus: 'nodata', lastAdded: 0 };
    const result = presentUsageCatchUpStatus(true, nodata, 'en-US', t);
    expect(result?.tone).toBe('warn');
  });

  it('maps skipped status to warn tone', () => {
    const skipped: UsageCatchUpRunStatus = { ...baseStatus, lastStatus: 'skipped', lastAdded: 0 };
    const result = presentUsageCatchUpStatus(true, skipped, 'en-US', t);
    expect(result?.tone).toBe('warn');
  });

  it('reflects the reconnect trigger in the title', () => {
    const reconnect: UsageCatchUpRunStatus = { ...baseStatus, trigger: 'reconnect' };
    const result = presentUsageCatchUpStatus(true, reconnect, 'en-US', t);
    expect(result?.title).toContain('reconnect');
  });
});
