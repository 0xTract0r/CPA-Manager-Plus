import { describe, expect, it } from 'vitest';
import type { AuthFileItem } from '@/types';
import { createCodexReauthTargetFromInspectionRecord } from './codexReauthModel';

// 服务端巡检历史记录 → 重新登录目标：fileName 会作为 auth_name 传给 core，
// 必须优先用当前匹配到的认证文件名；账号改名后历史文件名已不存在，用它会被 core 400。
describe('createCodexReauthTargetFromInspectionRecord', () => {
  const record = {
    fileName: 'codex-old-name.json',
    displayAccount: 'target@example.com',
    authIndex: '7',
    accountId: 'acct-1',
  };

  it('匹配到当前认证文件时，fileName 用当前文件名而不是历史文件名', () => {
    const matched = {
      name: 'codex-renamed.json',
      email: 'target@example.com',
      type: 'codex',
    } as AuthFileItem;

    const target = createCodexReauthTargetFromInspectionRecord(record, matched);

    expect(target.fileName).toBe('codex-renamed.json');
    expect(target.account).toBe('target@example.com');
    expect(target.authIndex).toBe('7');
    expect(target.accountId).toBe('acct-1');
  });

  it('未匹配到当前认证文件时，退回历史记录里的文件名', () => {
    const target = createCodexReauthTargetFromInspectionRecord(record, null);

    expect(target.fileName).toBe('codex-old-name.json');
    expect(target.account).toBe('target@example.com');
  });
});
