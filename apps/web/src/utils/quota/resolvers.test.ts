import { describe, expect, it } from 'vitest';
import type { AuthFileItem } from '@/types';
import { extractGeminiCliProjectId, resolveGeminiCliProjectId } from './resolvers';

const makeFile = (overrides: Record<string, unknown>): AuthFileItem =>
  ({ name: 'gemini.json', ...overrides }) as AuthFileItem;

describe('extractGeminiCliProjectId', () => {
  it('returns null for non-string input', () => {
    expect(extractGeminiCliProjectId(null)).toBeNull();
    expect(extractGeminiCliProjectId(undefined)).toBeNull();
    expect(extractGeminiCliProjectId(123)).toBeNull();
    expect(extractGeminiCliProjectId({ account: 'x (y)' })).toBeNull();
  });

  it('extracts the trimmed id from the trailing parentheses', () => {
    expect(extractGeminiCliProjectId('user@example.com (my-project-123)')).toBe(
      'my-project-123'
    );
  });

  it('picks the last parenthesised group when several are present', () => {
    expect(extractGeminiCliProjectId('foo (first) bar (second)')).toBe('second');
  });

  it('trims whitespace inside the parentheses', () => {
    expect(extractGeminiCliProjectId('x (  padded-id  )')).toBe('padded-id');
  });

  it('handles a value that is only a parenthesised id', () => {
    expect(extractGeminiCliProjectId('(only)')).toBe('only');
  });

  it('returns null when there are no parentheses', () => {
    expect(extractGeminiCliProjectId('no-parens-here')).toBeNull();
  });

  it('returns null for empty parentheses', () => {
    expect(extractGeminiCliProjectId('value ()')).toBeNull();
  });
});

describe('resolveGeminiCliProjectId', () => {
  it('resolves the project id from file.account', () => {
    expect(resolveGeminiCliProjectId(makeFile({ account: 'name (proj-1)' }))).toBe('proj-1');
  });

  it('falls through to metadata.account when file.account has no id', () => {
    const file = makeFile({
      account: 'no-parens',
      metadata: { account: 'meta (from-meta)' },
    });
    expect(resolveGeminiCliProjectId(file)).toBe('from-meta');
  });

  it('falls through to attributes.account when earlier sources are absent', () => {
    const file = makeFile({ attributes: { account: 'label (attr-proj)' } });
    expect(resolveGeminiCliProjectId(file)).toBe('attr-proj');
  });

  it('returns null when no source yields a project id', () => {
    expect(resolveGeminiCliProjectId(makeFile({ account: 'plain-name' }))).toBeNull();
    expect(resolveGeminiCliProjectId(makeFile({}))).toBeNull();
  });
});

import {
  isCodexChatgptAccountIdInvalid,
  resolveCodexChatgptAccountId,
  resolveCodexChatgptAccountIdEvidence,
} from './resolvers';

describe('resolveCodexChatgptAccountId', () => {
  it.each([
    { field: 'chatgpt_account_id', value: 'chatgpt-account' },
    { field: 'chatgptAccountId', value: 'chatgpt-account-camel' },
    { field: 'account_id', value: 'account' },
    { field: 'accountId', value: 'account-camel' },
  ])('reads a direct $field string', ({ field, value }) => {
    expect(resolveCodexChatgptAccountId({ name: 'codex.json', [field]: ` ${value} ` })).toBe(value);
  });

  it('still extracts an account ID from an id_token payload object', () => {
    expect(
      resolveCodexChatgptAccountId({
        name: 'codex.json',
        id_token: { account_id: 'token-account' },
      })
    ).toBe('token-account');
  });

  it('rejects conflicting explicit Workspace evidence instead of using the first candidate', () => {
    const file = {
      name: 'codex.json',
      account_id: 'workspace-a',
      metadata: { id_token: { chatgpt_account_id: 'workspace-b' } },
    };
    expect(resolveCodexChatgptAccountId(file)).toBeNull();
    expect(resolveCodexChatgptAccountIdEvidence(file)).toEqual({ accountId: null, invalid: true });
    expect(isCodexChatgptAccountIdInvalid(file)).toBe(true);
  });

  it('rejects malformed explicit Workspace evidence even when another candidate is valid', () => {
    const file = {
      name: 'codex.json',
      account_id: 'workspace-a',
      chatgptAccountId: { unexpected: 'object' },
    };
    expect(resolveCodexChatgptAccountId(file)).toBeNull();
    expect(isCodexChatgptAccountIdInvalid(file)).toBe(true);
  });

  it('accepts matching direct and JWT Workspace evidence', () => {
    const payload = btoa(JSON.stringify({ chatgpt_account_id: 'workspace-a' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(
      resolveCodexChatgptAccountId({
        name: 'codex.json',
        account_id: ' workspace-a ',
        id_token: `header.${payload}.signature`,
      })
    ).toBe('workspace-a');
  });

  it.each([
    ['workspace-a\t', 'workspace-a\t'],
    ['workspace-a\u2003', 'workspace-a\u2003'],
    ['workspace-a\u0000', 'workspace-a\u0000'],
    ['工作区-a', '工作区-a'],
  ])('preserves opaque Workspace value %j', (value, expected) => {
    expect(resolveCodexChatgptAccountId({ name: 'codex.json', account_id: ` ${value} ` })).toBe(expected);
  });
});
