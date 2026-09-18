import { describe, expect, it } from 'vitest';
import {
  compactAuthFileNameForDisplay,
  findAuthFileForIdentity,
  findAuthIndicesMatchingIdentityQuery,
  getAuthFileIdentitySearchValues,
  maskAccountEmail,
  maskAccountEmailsInText,
  resolveAccountIdentity,
  resolveAuthFileAccountIdentity,
  withIdentitySearchAuthIndices,
} from './accountIdentity';

describe('accountIdentity', () => {
  it('uses the trimmed note as primary and a masked email as secondary', () => {
    expect(
      resolveAccountIdentity({
        note: '  上海研发 · 主力池  ',
        email: 'Owner.Name+prod@accounts.example.test',
        fallback: 'codex-owner.json',
      })
    ).toMatchObject({
      primary: '上海研发 · 主力池',
      secondary: 'Owner.Name+prod@accounts.example.test',
      email: 'Owner.Name+prod@accounts.example.test',
      hasNote: true,
      primaryIsEmail: false,
    });
  });

  it('uses the full account email as primary when the note is empty', () => {
    expect(resolveAccountIdentity({ note: '  ', email: 'qa+fallback@example.test' })).toMatchObject(
      {
        primary: 'qa+fallback@example.test',
        secondary: '',
        hasNote: false,
        primaryIsEmail: true,
      }
    );
  });

  it('does not infer an account email from an email-like file name', () => {
    expect(
      resolveAuthFileAccountIdentity({
        name: 'operator.long+tag@example.test.json',
        account_settings: { note: '夜间批处理' } as never,
      })
    ).toMatchObject({
      primary: '夜间批处理',
      email: '',
      fallback: 'operator.long+tag@example.test',
    });
  });

  it('keeps full email and note in search values while visible text stays masked', () => {
    const file = {
      name: 'prod-a.json',
      authIndex: 'auth-prod-a',
      email: 'Sensitive.Owner@example.test',
      note: '客户成功 APAC',
    };
    expect(getAuthFileIdentitySearchValues(file)).toEqual(
      expect.arrayContaining([
        '客户成功 APAC',
        'Sensitive.Owner@example.test',
        'Se***@example.test',
      ])
    );
    expect(maskAccountEmail(file.email)).toBe('Se***@example.test');
  });

  it('masks email tokens embedded in diagnostic text', () => {
    expect(
      maskAccountEmailsInText('owner.long@example.test failed; qa+x@lab.example.test retry')
    ).toBe('ow***@example.test failed; qa***@lab.example.test retry');
  });

  it('collapses a duplicated account email inside an auth filename without losing suffixes', () => {
    expect(
      compactAuthFileNameForDisplay(
        'claude-owner.primary@example.test.json',
        'owner.primary@example.test'
      )
    ).toBe('claude-….json');
    expect(
      compactAuthFileNameForDisplay(
        'codex-owner.plus@example.test-pro.json',
        'owner.plus@example.test'
      )
    ).toBe('codex-…-pro.json');
    expect(compactAuthFileNameForDisplay('custom-credential.json', 'owner@example.test')).toBe(
      'custom-credential.json'
    );
  });

  it('never exposes an embedded email through a non-email fallback label', () => {
    expect(resolveAccountIdentity({ fallback: 'archive-owner@example.test-backup' })).toMatchObject(
      {
        primary: 'archive-owner@example.test-backup',
        fallback: 'archive-owner@example.test-backup',
        maskedFallback: 'ar***@example.test-backup',
      }
    );
  });

  it('finds current files by strong identity keys without relying on duplicate notes', () => {
    const files = [
      { name: 'a.json', authIndex: 'auth-a', provider: 'codex', note: '同名池' },
      { name: 'b.json', authIndex: 'auth-b', provider: 'claude', note: '同名池' },
    ];
    expect(findAuthFileForIdentity(files, { authIndex: 'auth-b' })?.name).toBe('b.json');
    expect(findAuthFileForIdentity(files, { fileName: 'a.json' })?.name).toBe('a.json');
    expect(findAuthFileForIdentity(files, { email: 'missing@example.test' })).toBeUndefined();
  });

  it('maps case-insensitive note and full-email queries to auth indices', () => {
    const files = [
      {
        name: 'a.json',
        authIndex: 'auth-a',
        email: 'Owner+Blue@example.test',
        note: '蓝组主账号',
      },
      { name: 'b.json', authIndex: 'auth-b', email: 'backup@example.test', note: '备用' },
    ];
    expect(findAuthIndicesMatchingIdentityQuery(files, '蓝组')).toEqual(['auth-a']);
    expect(findAuthIndicesMatchingIdentityQuery(files, 'owner+blue')).toEqual(['auth-a']);
    expect(findAuthIndicesMatchingIdentityQuery(files, 'a.json')).toEqual([]);
    expect(findAuthIndicesMatchingIdentityQuery(files, 'auth-a')).toEqual([]);
  });

  it('adds identity matches as a separate search scope without replacing filters', () => {
    const filters = withIdentitySearchAuthIndices(
      { models: ['needle-model'], auth_indices: ['explicit-scope'] },
      ['auth-note', 'auth-note', '']
    );
    expect(filters).toEqual({
      models: ['needle-model'],
      auth_indices: ['explicit-scope'],
      search_auth_indices: ['auth-note'],
    });
  });
});
