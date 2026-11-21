import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    request: vi.fn(),
  },
}));

vi.mock('./apiCall', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./apiCall')>();
  return {
    ...actual,
    apiCallApi: {
      request: mocks.request,
    },
  };
});

import { modelsApi } from './models';

const successfulResult = (body: unknown) => ({
  statusCode: 200,
  hasStatusCode: true,
  header: {},
  bodyText: JSON.stringify(body),
  body,
});

beforeEach(() => {
  mocks.request.mockReset();
});

describe('modelsApi request-level proxy', () => {
  it('keeps the auth-index for keyless proxy routing without resolving a missing token', async () => {
    mocks.request.mockResolvedValueOnce(successfulResult({ data: [{ id: 'local-model' }] }));

    await modelsApi.fetchModelsViaApiCall(
      'https://keyless.example.com/v1',
      undefined,
      {},
      'auth-keyless',
      'socks5://keyless-proxy.example:1080',
      true
    );

    expect(mocks.request).toHaveBeenCalledWith({
      authIndex: 'auth-keyless',
      proxyUrl: 'socks5://keyless-proxy.example:1080',
      method: 'GET',
      url: 'https://keyless.example.com/v1/models',
      header: undefined,
    });
  });

  it('preserves indexed credential token substitution for other callers', async () => {
    mocks.request.mockResolvedValueOnce(successfulResult({ data: [{ id: 'indexed-model' }] }));

    await modelsApi.fetchModelsViaApiCall(
      'https://indexed.example.com/v1',
      undefined,
      {},
      'auth-with-key'
    );

    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        authIndex: 'auth-with-key',
        header: { Authorization: 'Bearer $TOKEN$' },
      })
    );
  });

  it('does not overwrite custom Authorization on keyless requests', async () => {
    mocks.request.mockResolvedValueOnce(successfulResult({ data: [{ id: 'custom-model' }] }));
    await modelsApi.fetchModelsViaApiCall(
      'https://keyless.example.com/v1',
      undefined,
      { Authorization: 'Basic custom-auth' },
      'auth-keyless',
      undefined,
      true
    );
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({ header: { Authorization: 'Basic custom-auth' } })
    );
  });

  it.each([
    ['v1', modelsApi.fetchV1ModelsViaApiCall, 'https://api.example.com/v1/models'],
    ['openai', modelsApi.fetchModelsViaApiCall, 'https://api.example.com/models'],
    ['claude', modelsApi.fetchClaudeModelsViaApiCall, 'https://api.example.com/v1/models'],
  ] as const)('passes the trimmed proxy to %s model discovery', async (_, fetchModels, url) => {
    mocks.request.mockResolvedValueOnce(successfulResult({ data: [{ id: 'model-1' }] }));

    await fetchModels(
      'https://api.example.com',
      'api-key',
      {},
      'auth-1',
      '  socks5://proxy.example:1080  '
    );

    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        authIndex: 'auth-1',
        proxyUrl: 'socks5://proxy.example:1080',
        method: 'GET',
        url,
      })
    );
  });

  it.each([false, true])(
    'shares Gemini pagination but keeps default and exact results separate (exact first = %s)',
    async (exactFirst) => {
      const firstPage = successfulResult({
        models: [{ name: 'models/DemoAlias', displayName: 'first occurrence' }],
        nextPageToken: 'fixture-page-2',
      });
      let finishFirstPage!: (result: typeof firstPage) => void;
      mocks.request
        .mockImplementationOnce(
          () =>
            new Promise<typeof firstPage>((resolve) => {
              finishFirstPage = resolve;
            })
        )
        .mockResolvedValueOnce(
          successfulResult({
            models: [
              { name: 'models/DemoAlias', displayName: 'duplicates are ignored' },
              { name: 'models/demoalias' },
            ],
          })
        );

      const catalog = 'https://catalog.invalid';
      const discover = (exact: boolean) =>
        exact
          ? modelsApi.fetchGeminiModelsViaApiCall(catalog, undefined, {}, undefined, undefined, {
              dedupe: 'exact',
            })
          : modelsApi.fetchGeminiModelsViaApiCall(catalog);
      const first = discover(exactFirst);
      const second = discover(!exactFirst);
      expect(mocks.request).toHaveBeenCalledTimes(1);
      finishFirstPage(firstPage);

      const [firstResult, secondResult] = await Promise.all([first, second]);
      const exact = exactFirst ? firstResult : secondResult;
      const defaultMode = exactFirst ? secondResult : firstResult;
      expect(mocks.request).toHaveBeenCalledTimes(2);
      expect(mocks.request.mock.calls[1][0].url).toContain('pageToken=fixture-page-2');
      expect(defaultMode.map(({ name }) => name)).toEqual(['DemoAlias']);
      expect(exact.map(({ name }) => name)).toEqual(['DemoAlias', 'demoalias']);
      expect(exact[0].displayName).toBe('first occurrence');
    }
  );

  it('passes the proxy to every Gemini model page', async () => {
    mocks.request
      .mockResolvedValueOnce(
        successfulResult({ models: [{ name: 'models/gemini-1' }], nextPageToken: 'page-2' })
      )
      .mockResolvedValueOnce(successfulResult({ models: [{ name: 'models/gemini-2' }] }));

    await expect(
      modelsApi.fetchGeminiModelsViaApiCall(
        'https://generativelanguage.googleapis.com',
        'api-key',
        {},
        undefined,
        'https://proxy.example:8443'
      )
    ).resolves.toEqual([{ name: 'gemini-1' }, { name: 'gemini-2' }]);

    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(mocks.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ proxyUrl: 'https://proxy.example:8443' })
    );
    expect(mocks.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        proxyUrl: 'https://proxy.example:8443',
        url: expect.stringContaining('pageToken=page-2'),
      })
    );
  });

  it.each([
    ['Claude', modelsApi.fetchClaudeModelsViaApiCall],
    ['Gemini', modelsApi.fetchGeminiModelsViaApiCall],
  ] as const)(
    'reuses in-flight %s requests only when the proxy matches',
    async (_, fetchModels) => {
      let resolveFirst: ((value: ReturnType<typeof successfulResult>) => void) | undefined;
      mocks.request
        .mockImplementationOnce(
          () =>
            new Promise<ReturnType<typeof successfulResult>>((resolve) => {
              resolveFirst = resolve;
            })
        )
        .mockResolvedValueOnce(successfulResult({ models: [{ name: 'model-b' }] }));

      const first = fetchModels(
        'https://api.example.com',
        'api-key',
        {},
        'auth-1',
        'socks5://proxy-a.example:1080'
      );
      const sameProxy = fetchModels(
        'https://api.example.com',
        'api-key',
        {},
        'auth-1',
        '  socks5://proxy-a.example:1080  '
      );
      const differentProxy = fetchModels(
        'https://api.example.com',
        'api-key',
        {},
        'auth-1',
        'socks5://proxy-b.example:1080'
      );

      expect(mocks.request).toHaveBeenCalledTimes(2);
      resolveFirst?.(successfulResult({ models: [{ name: 'model-a' }] }));

      await expect(Promise.all([first, sameProxy, differentProxy])).resolves.toHaveLength(3);
    }
  );
});


describe('Claude model discovery authentication', () => {
  it('uses x-api-key for Anthropic first-party API keys', async () => {
    mocks.request.mockResolvedValueOnce(successfulResult({ data: [{ id: 'claude-1' }] }));
    await modelsApi.fetchClaudeModelsViaApiCall('https://api.anthropic.com', 'api-key');
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        header: expect.objectContaining({
          'x-api-key': 'api-key',
          'anthropic-version': '2023-06-01',
        }),
      })
    );
    expect(mocks.request.mock.calls[0]?.[0]?.header).not.toHaveProperty('Authorization');
  });

  it('uses Bearer auth for custom Claude upstreams', async () => {
    mocks.request.mockResolvedValueOnce(successfulResult({ data: [{ id: 'claude-1' }] }));
    await modelsApi.fetchClaudeModelsViaApiCall('https://gateway.example.com', 'api-key');
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        header: expect.objectContaining({ Authorization: 'Bearer api-key' }),
      })
    );
    expect(mocks.request.mock.calls[0]?.[0]?.header).not.toHaveProperty('x-api-key');
  });

  it('adds the Claude OAuth beta for Anthropic OAuth tokens', async () => {
    mocks.request.mockResolvedValueOnce(successfulResult({ data: [{ id: 'claude-1' }] }));
    await modelsApi.fetchClaudeModelsViaApiCall(
      'https://api.anthropic.com',
      'sk-ant-oat-test-token'
    );
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        header: expect.objectContaining({
          Authorization: 'Bearer sk-ant-oat-test-token',
          'anthropic-beta': 'oauth-2025-04-20',
        }),
      })
    );
    expect(mocks.request.mock.calls[0]?.[0]?.header).not.toHaveProperty('x-api-key');
  });

  it('protects the OAuth beta from custom headers on Anthropic model discovery', async () => {
    mocks.request.mockResolvedValueOnce(successfulResult({ data: [{ id: 'claude-1' }] }));
    await modelsApi.fetchClaudeModelsViaApiCall(
      'https://api.anthropic.com',
      'sk-ant-oat-test-token',
      { 'Anthropic-Beta': 'custom-beta' }
    );
    const header = mocks.request.mock.calls[0]?.[0]?.header ?? {};
    expect(header['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(header).not.toHaveProperty('Anthropic-Beta');
  });

  it('keeps custom OAuth beta overrides for third-party model discovery', async () => {
    mocks.request.mockResolvedValueOnce(successfulResult({ data: [{ id: 'claude-1' }] }));
    await modelsApi.fetchClaudeModelsViaApiCall(
      'https://gateway.example.com',
      'sk-ant-oat-test-token',
      { 'Anthropic-Beta': 'custom-beta' }
    );
    expect(mocks.request.mock.calls[0]?.[0]?.header).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer sk-ant-oat-test-token',
        'Anthropic-Beta': 'custom-beta',
      })
    );
  });

  it('keeps custom Authorization as a header-only credential', async () => {
    mocks.request.mockResolvedValueOnce(successfulResult({ data: [{ id: 'claude-1' }] }));
    await modelsApi.fetchClaudeModelsViaApiCall(
      'https://gateway.example.com',
      undefined,
      { Authorization: 'Bearer custom-token' },
      'auth-1'
    );
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        header: expect.objectContaining({ Authorization: 'Bearer custom-token' }),
      })
    );
    expect(mocks.request.mock.calls[0]?.[0]?.header).not.toHaveProperty('x-api-key');
  });
});
