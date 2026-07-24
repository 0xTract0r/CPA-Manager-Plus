import { describe, expect, it } from 'vitest';
import {
  normalizeGeminiCliModelId,
  parseGeminiCliCodeAssistPayload,
  parseGeminiCliQuotaPayload,
} from './parsers';

describe('normalizeGeminiCliModelId', () => {
  it('strips a trailing _vertex suffix', () => {
    expect(normalizeGeminiCliModelId('gemini-2.5-pro_vertex')).toBe('gemini-2.5-pro');
    expect(normalizeGeminiCliModelId('gemini-2.5-flash-lite_vertex')).toBe(
      'gemini-2.5-flash-lite'
    );
  });

  it('leaves ids without the suffix unchanged', () => {
    expect(normalizeGeminiCliModelId('gemini-2.5-pro')).toBe('gemini-2.5-pro');
  });

  it('only strips the suffix at the end, not mid-string', () => {
    expect(normalizeGeminiCliModelId('foo_vertex_bar')).toBe('foo_vertex_bar');
  });

  it('trims surrounding whitespace before normalizing', () => {
    expect(normalizeGeminiCliModelId('  gemini-2.5-flash_vertex  ')).toBe('gemini-2.5-flash');
  });

  it('coerces finite numbers to their string form', () => {
    expect(normalizeGeminiCliModelId(123)).toBe('123');
  });

  it('returns null for empty, whitespace, nullish, or non-string/number input', () => {
    expect(normalizeGeminiCliModelId('')).toBeNull();
    expect(normalizeGeminiCliModelId('   ')).toBeNull();
    expect(normalizeGeminiCliModelId(null)).toBeNull();
    expect(normalizeGeminiCliModelId(undefined)).toBeNull();
    expect(normalizeGeminiCliModelId({})).toBeNull();
    expect(normalizeGeminiCliModelId(Number.NaN)).toBeNull();
  });
});

describe('parseGeminiCliQuotaPayload', () => {
  it('returns null for nullish input', () => {
    expect(parseGeminiCliQuotaPayload(null)).toBeNull();
    expect(parseGeminiCliQuotaPayload(undefined)).toBeNull();
  });

  it('returns null for empty or whitespace-only strings', () => {
    expect(parseGeminiCliQuotaPayload('')).toBeNull();
    expect(parseGeminiCliQuotaPayload('   ')).toBeNull();
  });

  it('returns null for malformed JSON strings', () => {
    expect(parseGeminiCliQuotaPayload('{not valid json')).toBeNull();
  });

  it('parses a valid JSON string into an object', () => {
    expect(parseGeminiCliQuotaPayload('{"buckets":[{"modelId":"gemini-2.5-pro"}]}')).toEqual({
      buckets: [{ modelId: 'gemini-2.5-pro' }],
    });
  });

  it('passes through an already-parsed object by reference', () => {
    const payload = { buckets: [{ modelId: 'gemini-2.5-pro' }] };
    expect(parseGeminiCliQuotaPayload(payload)).toBe(payload);
  });

  it('returns null for non-string, non-object primitives', () => {
    expect(parseGeminiCliQuotaPayload(5)).toBeNull();
    expect(parseGeminiCliQuotaPayload(true)).toBeNull();
  });
});

describe('parseGeminiCliCodeAssistPayload', () => {
  it('returns null for nullish input', () => {
    expect(parseGeminiCliCodeAssistPayload(null)).toBeNull();
    expect(parseGeminiCliCodeAssistPayload(undefined)).toBeNull();
  });

  it('returns null for empty or whitespace-only strings', () => {
    expect(parseGeminiCliCodeAssistPayload('')).toBeNull();
    expect(parseGeminiCliCodeAssistPayload('   ')).toBeNull();
  });

  it('returns null for malformed JSON strings', () => {
    expect(parseGeminiCliCodeAssistPayload('{oops')).toBeNull();
  });

  it('parses a valid JSON string into an object', () => {
    expect(
      parseGeminiCliCodeAssistPayload('{"currentTier":{"id":"g1-ultra-tier"}}')
    ).toEqual({ currentTier: { id: 'g1-ultra-tier' } });
  });

  it('passes through an already-parsed object by reference', () => {
    const payload = { currentTier: { id: 'g1-ultra-tier' } };
    expect(parseGeminiCliCodeAssistPayload(payload)).toBe(payload);
  });

  it('returns null for non-string, non-object primitives', () => {
    expect(parseGeminiCliCodeAssistPayload(42)).toBeNull();
  });
});
