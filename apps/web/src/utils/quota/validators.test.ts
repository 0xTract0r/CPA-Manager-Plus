import { describe, expect, it } from 'vitest';
import type { AuthFileItem } from '@/types';
import { isGeminiCliFile, isIgnoredGeminiCliModel } from './validators';

const makeFile = (overrides: Record<string, unknown>): AuthFileItem =>
  ({ name: 'gemini.json', ...overrides }) as AuthFileItem;

describe('isGeminiCliFile', () => {
  it('recognizes the canonical provider value', () => {
    expect(isGeminiCliFile(makeFile({ provider: 'gemini-cli' }))).toBe(true);
  });

  it('normalizes underscores to hyphens on the type field', () => {
    expect(isGeminiCliFile(makeFile({ type: 'gemini_cli' }))).toBe(true);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(isGeminiCliFile(makeFile({ provider: 'GEMINI-CLI' }))).toBe(true);
    expect(isGeminiCliFile(makeFile({ type: '  gemini-cli  ' }))).toBe(true);
  });

  it('falls back to the typo field when provider and type are absent', () => {
    expect(isGeminiCliFile(makeFile({ typo: 'gemini_cli' }))).toBe(true);
  });

  it('rejects other providers', () => {
    expect(isGeminiCliFile(makeFile({ provider: 'gemini' }))).toBe(false);
    expect(isGeminiCliFile(makeFile({ provider: 'codex' }))).toBe(false);
    expect(isGeminiCliFile(makeFile({}))).toBe(false);
  });

  it('gives provider precedence over type', () => {
    expect(isGeminiCliFile(makeFile({ provider: 'codex', type: 'gemini-cli' }))).toBe(false);
  });
});

describe('isIgnoredGeminiCliModel', () => {
  it('ignores the exact gemini-2.0-flash id', () => {
    expect(isIgnoredGeminiCliModel('gemini-2.0-flash')).toBe(true);
  });

  it('ignores hyphenated gemini-2.0-flash variants', () => {
    expect(isIgnoredGeminiCliModel('gemini-2.0-flash-exp')).toBe(true);
    expect(isIgnoredGeminiCliModel('gemini-2.0-flash-001')).toBe(true);
    expect(isIgnoredGeminiCliModel('gemini-2.0-flash-lite')).toBe(true);
  });

  it('does not ignore models outside the prefix', () => {
    expect(isIgnoredGeminiCliModel('gemini-2.5-flash')).toBe(false);
    expect(isIgnoredGeminiCliModel('gemini-2.0')).toBe(false);
    expect(isIgnoredGeminiCliModel('')).toBe(false);
  });

  it('does not ignore prefix look-alikes without the hyphen boundary', () => {
    expect(isIgnoredGeminiCliModel('gemini-2.0-flashx')).toBe(false);
  });
});
