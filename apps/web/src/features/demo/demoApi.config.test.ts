import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  handleDemoApiRequest,
  handleDemoRawRequest,
  resetDemoConfigState,
} from './demoApi';

const weightedConfigYaml = [
  'debug: true',
  'request-log: true',
  'logging-to-file: true',
  'routing:',
  '  strategy: weighted-round-robin',
  'plugins:',
  '  enabled: true',
].join('\n');

describe('demo configuration API', () => {
  beforeEach(() => {
    resetDemoConfigState();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetDemoConfigState();
  });

  it('persists config.yaml updates across YAML, raw config, and routing reads', async () => {
    await handleDemoApiRequest('put', '/config.yaml', weightedConfigYaml);

    const configYaml = await handleDemoApiRequest<string>('get', '/config.yaml');
    const rawResponse = await handleDemoRawRequest('/config.yaml');
    const rawConfig = await handleDemoApiRequest<Record<string, unknown>>('get', '/config');
    const routing = await handleDemoApiRequest<{ strategy: string }>(
      'get',
      '/routing/strategy'
    );

    expect(configYaml).toBe(weightedConfigYaml);
    expect(rawResponse.data).toBe(weightedConfigYaml);
    expect(rawConfig).toMatchObject({
      debug: true,
      routing: { strategy: 'weighted-round-robin' },
    });
    expect(rawConfig['codex-api-key']).toEqual(expect.any(Array));
    expect(routing).toEqual({ strategy: 'weighted-round-robin' });
  });

  it('keeps direct routing strategy updates consistent with config.yaml and raw config', async () => {
    await handleDemoApiRequest('put', '/routing/strategy', { value: 'fill-first' });

    const configYaml = await handleDemoApiRequest<string>('get', '/config.yaml');
    const parsed = parseYaml(configYaml) as { routing?: { strategy?: string } };
    const rawConfig = await handleDemoApiRequest<Record<string, unknown>>('get', '/config');
    const routing = await handleDemoApiRequest<{ strategy: string }>(
      'get',
      '/routing/strategy'
    );

    expect(parsed.routing?.strategy).toBe('fill-first');
    expect(rawConfig).toMatchObject({ routing: { strategy: 'fill-first' } });
    expect(routing).toEqual({ strategy: 'fill-first' });
  });

  it('preserves trailing blank lines in unrelated YAML values when toggling logging', async () => {
    const yaml = 'request-log: true\nplugins:\n  template: |+\n    example\n\n';
    await handleDemoApiRequest('put', '/config.yaml', yaml);
    await handleDemoApiRequest('put', '/request-log', { value: false });
    const result = await handleDemoApiRequest<string>('get', '/config.yaml');
    expect(parseYaml(result)).toEqual({ ...parseYaml(yaml), 'request-log': false });
  });

  it('rejects malformed YAML before replacing the current configuration', async () => {
    const before = await handleDemoApiRequest<string>('get', '/config.yaml');
    await expect(handleDemoApiRequest('put', '/config.yaml', 'request-log: [\n')).rejects.toMatchObject({
      status: 400,
    });
    expect(await handleDemoApiRequest('get', '/config.yaml')).toBe(before);
  });

  it('lists historical error logs only while request logging is disabled', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-06-29T12:00:00Z') });
    const list = () =>
      handleDemoApiRequest<{ files: { name: string }[] }>('get', '/request-error-logs');
    expect(await list()).toEqual({ files: [] });

    await handleDemoApiRequest('put', '/request-log', { value: false });
    expect(await handleDemoApiRequest('get', '/request-log')).toEqual({ 'request-log': false });
    const configYaml = await handleDemoApiRequest<string>('get', '/config.yaml');
    expect(parseYaml(configYaml)['request-log']).toBe(false);
    const history = await list();
    expect(history.files).toHaveLength(2);

    await handleDemoApiRequest('put', '/request-log', { value: true });
    expect(await handleDemoApiRequest('get', '/config')).toMatchObject({ 'request-log': true });
    expect(await list()).toEqual({ files: [] });

    await handleDemoApiRequest('put', '/config.yaml', configYaml);
    expect(await list()).toEqual(history);
  });

  it('resets session configuration back to the fixture baseline', async () => {
    await handleDemoApiRequest('put', '/config.yaml', weightedConfigYaml);
    resetDemoConfigState();

    const configYaml = await handleDemoApiRequest<string>('get', '/config.yaml');
    const parsed = parseYaml(configYaml) as { routing?: { strategy?: string } };
    const routing = await handleDemoApiRequest<{ strategy: string }>(
      'get',
      '/routing/strategy'
    );

    expect(parsed.routing?.strategy).toBe('round-robin');
    expect(routing).toEqual({ strategy: 'round-robin' });
  });
});
