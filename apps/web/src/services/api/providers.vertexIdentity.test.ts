import { beforeEach, describe, it, expect, vi } from 'vitest';
const { apiMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('./client', () => ({ apiClient: apiMock }));
import { providersApi } from './providers';
beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.put.mockReset();
  apiMock.put.mockResolvedValue({});
});
const key = 'candidate-fake-vertex-unit',
  base = 'https://vertex-unit.invalid/v1';
const original = {
  apiKey: key,
  baseUrl: base,
  authIndex: 'synthetic-derived-index',
  prefix: 'before',
};
const value = { ...original, prefix: 'after' };
describe('Vertex single-record identity', () => {
  it('edits endpoint-derived identity against raw config without that derived field', async () => {
    const sentinel = {
      'api-key': 'candidate-sentinel',
      'base-url': 'https://sentinel.invalid/v1',
      prefix: 'concurrent',
      unknown: 9,
    };
    apiMock.get.mockResolvedValue({
      'vertex-api-key': [
        sentinel,
        { 'api-key': key, 'base-url': base, prefix: 'before', unknown: 7 },
      ],
    });
    await providersApi.updateVertexConfig(original, value);
    const saved = apiMock.put.mock.calls[0][1];
    expect(saved[0]).toEqual(sentinel);
    expect(saved[1]).not.toHaveProperty('auth-index');
    expect(saved[1]).toMatchObject({
      'api-key': key,
      'base-url': base,
      prefix: 'after',
      unknown: 7,
    });
  });
  it('preserves a stored index under its original field name', async () => {
    apiMock.get.mockResolvedValue({
      'vertex-api-key': [{ 'api-key': key, 'base-url': base, auth_index: original.authIndex }],
    });
    await providersApi.updateVertexConfig(original, value);
    const target = apiMock.put.mock.calls[0][1][0];
    expect(target.auth_index).toBe(original.authIndex);
    expect(target).not.toHaveProperty('auth-index');
  });

  for (const [name, rows] of [
    [
      'duplicate raw identity',
      [
        { 'api-key': key, 'base-url': base },
        { 'api-key': key, 'base-url': base },
      ],
    ],
    [
      'old key after current key changed',
      [{ 'api-key': 'candidate-rotated-key', 'base-url': base, 'auth-index': original.authIndex }],
    ],
    [
      'old base after current base changed',
      [
        {
          'api-key': key,
          'base-url': 'https://changed.invalid/v1',
          'auth-index': original.authIndex,
        },
      ],
    ],
    [
      'both indices present but different',
      [{ 'api-key': key, 'base-url': base, 'auth-index': 'foreign-index' }],
    ],
    [
      'mixed conflicting and absent indices on duplicate raw identity',
      [
        { 'api-key': key, 'base-url': base, 'auth-index': 'foreign-index' },
        { 'api-key': key, 'base-url': base },
      ],
    ],
    ['removed original', []],
  ] as const) {
    it('rejects ' + name + ' without PUT', async () => {
      apiMock.get.mockResolvedValue({ 'vertex-api-key': rows });
      await expect(providersApi.updateVertexConfig(original, value)).rejects.toThrow(
        'Provider configuration changed'
      );
      expect(apiMock.put).not.toHaveBeenCalled();
    });
  }
  it('retains later queued record update without losing concurrent rows', async () => {
    let state: Array<Record<string, unknown>> = [
      { 'api-key': key, 'base-url': base, prefix: 'before' },
      { 'api-key': 'candidate-other', 'base-url': 'https://other.invalid', unknown: 11 },
    ];
    apiMock.get.mockImplementation(async () => ({ 'vertex-api-key': structuredClone(state) }));
    apiMock.put.mockImplementation(async (_path, rows) => {
      state = structuredClone(rows);
    });
    await Promise.all([
      providersApi.updateVertexConfig(original, value),
      providersApi.updateVertexConfig(
        { apiKey: 'candidate-other', baseUrl: 'https://other.invalid' },
        { apiKey: 'candidate-other', baseUrl: 'https://other.invalid', prefix: 'other-after' }
      ),
    ]);
    expect(state).toHaveLength(2);
    expect(state[0].prefix).toBe('after');
    expect(state[1]).toMatchObject({ prefix: 'other-after', unknown: 11 });
  });
});
