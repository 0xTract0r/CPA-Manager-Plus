import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock('./client', () => ({
  apiClient: {
    get: mocks.get,
    post: mocks.post,
  },
}));

import { oauthApi } from './oauth';

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
});

describe('oauthApi', () => {
  it('marks built-in web UI OAuth starts with is_webui', async () => {
    mocks.get.mockResolvedValue({ url: 'https://auth.example/codex', state: 'state-1' });

    await oauthApi.startAuth('codex');

    expect(mocks.get).toHaveBeenCalledWith('/codex-auth-url', {
      params: { is_webui: true },
    });
  });

  it('starts plugin OAuth providers through their dynamic auth-url endpoint', async () => {
    mocks.get.mockResolvedValue({ url: 'https://auth.example/plugin', state: 'state-2' });

    await oauthApi.startAuth('sample-provider');

    expect(mocks.get).toHaveBeenCalledWith('/sample-provider-auth-url', {
      params: undefined,
    });
  });

  it('forwards authName as the auth_name query param for re-authentication', async () => {
    mocks.get.mockResolvedValue({ url: 'https://auth.example/anthropic', state: 'state-3' });

    await oauthApi.startAuth('anthropic', { authName: 'claude-primary.json' });

    expect(mocks.get).toHaveBeenCalledWith('/anthropic-auth-url', {
      params: { is_webui: true, auth_name: 'claude-primary.json' },
    });
  });

  it('sends project_id and is_webui for gemini-cli re-authentication', async () => {
    mocks.get.mockResolvedValue({ url: 'https://auth.example/gemini', state: 'state-4' });

    await oauthApi.startAuth('gemini-cli', {
      authName: 'gemini-work.json',
      projectId: 'gcp-project-123',
    });

    expect(mocks.get).toHaveBeenCalledWith('/gemini-cli-auth-url', {
      params: {
        is_webui: true,
        project_id: 'gcp-project-123',
        auth_name: 'gemini-work.json',
      },
    });
  });

  it('ignores projectId for non gemini-cli providers', async () => {
    mocks.get.mockResolvedValue({ url: 'https://auth.example/xai', state: 'state-5' });

    await oauthApi.startAuth('xai', { projectId: 'should-be-dropped' });

    expect(mocks.get).toHaveBeenCalledWith('/xai-auth-url', {
      params: { is_webui: true },
    });
  });

  it('maps gemini-cli to gemini when submitting the OAuth callback', async () => {
    mocks.post.mockResolvedValue({ status: 'ok' });

    await oauthApi.submitCallback('gemini-cli', 'https://localhost/callback?code=abc');

    expect(mocks.post).toHaveBeenCalledWith('/oauth-callback', {
      provider: 'gemini',
      redirect_url: 'https://localhost/callback?code=abc',
    });
  });

  it('keeps the provider name for non-mapped callback providers', async () => {
    mocks.post.mockResolvedValue({ status: 'ok' });

    await oauthApi.submitCallback('anthropic', 'https://localhost/callback?code=def');

    expect(mocks.post).toHaveBeenCalledWith('/oauth-callback', {
      provider: 'anthropic',
      redirect_url: 'https://localhost/callback?code=def',
    });
  });
});
