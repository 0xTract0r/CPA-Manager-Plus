import { describe, expect, it } from 'vitest';
import {
  findAuthFileForIdentity,
  findAuthIndicesMatchingIdentityQuery,
  getAuthFileIdentitySearchValues,
  maskAccountEmail,
  maskAccountEmailsInText,
  resolveAccountIdentity,
  resolveAuthFileAccountIdentity,
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
      secondary: 'Ow***@accounts.example.test',
      email: 'Owner.Name+prod@accounts.example.test',
      hasNote: true,
      primaryIsEmail: false,
    });
  });

  it('uses the masked email as primary when the note is empty', () => {
    expect(resolveAccountIdentity({ note: '  ', email: 'qa+fallback@example.test' })).toMatchObject(
      {
        primary: 'qa***@example.test',
        secondary: '',
        hasNote: false,
        primaryIsEmail: true,
      }
    );
  });

  it('extracts note/email from account settings and strips a JSON email suffix', () => {
    expect(
      resolveAuthFileAccountIdentity({
        name: 'operator.long+tag@example.test.json',
        account_settings: { note: '夜间批处理' } as never,
      })
    ).toMatchObject({
      primary: '夜间批处理',
      email: 'operator.long+tag@example.test',
      maskedEmail: 'op***@example.test',
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
});
