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
