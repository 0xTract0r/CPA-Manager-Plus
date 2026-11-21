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

  it.each(['request-log: [\n', '- demo\n', 'standalone\n'])(
    'rejects invalid configuration %j and keeps its previous value editable',
    async (invalidConfig) => {
      const before = await handleDemoApiRequest<string>('get', '/config.yaml');
      await expect(handleDemoApiRequest('put', '/config.yaml', invalidConfig)).rejects.toMatchObject({
        status: 400,
      });
      expect(await handleDemoApiRequest('get', '/config.yaml')).toBe(before);
      await handleDemoApiRequest('put', '/request-log', { value: false });
      expect(await handleDemoApiRequest('get', '/request-log')).toEqual({ 'request-log': false });
    }
  );

  it.each(['', '# comment\n', 'null\n'])('allows editing an empty configuration %j', async (yaml) => {
    await handleDemoApiRequest('put', '/config.yaml', yaml);
    await handleDemoApiRequest('put', '/request-log', { value: false });
    expect(await handleDemoApiRequest('get', '/request-log')).toEqual({ 'request-log': false });
  });

  it('reports an incompatible nested path without changing the document', async () => {
    const yaml = 'routing: old-value\nrequest-log: false\n';
    await handleDemoApiRequest('put', '/config.yaml', yaml);
    await expect(handleDemoApiRequest('put', '/routing/strategy', { value: 'fill-first' })).rejects.toMatchObject({
      status: 400,
    });
    expect(await handleDemoApiRequest('get', '/config.yaml')).toBe(yaml);
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

  it.each([
    { name: 'legacy omitted', yaml: 'port: 16743', initial: false, v8: false },
    { name: 'legacy null', yaml: 'request-log: null', initial: false, v8: false },
    { name: 'unknown section', yaml: 'ordinary-future-option: 2', initial: false, v8: false },
    { name: 'explicit v8', yaml: 'config-version: 8', initial: false, v8: true },
    { name: 'models parent', yaml: 'models: {}', initial: false, v8: true },
    { name: 'observability parent', yaml: 'observability: {}', initial: false, v8: true },
    { name: 'logs parent', yaml: 'observability: { logs: { error-logs-max-files: 9 } }', initial: false, v8: true },
    { name: 'canonical null wins', yaml: 'request-log: true\nobservability: { logs: { request-log: null } }', initial: false, v8: true },
    { name: 'canonical true wins', yaml: 'request-log: false\nobservability: { logs: { request-log: true } }', initial: true, v8: true },
    { name: 'canonical masks bad legacy', yaml: 'request-log: []\nobservability: { logs: { request-log: false } }', initial: false, v8: true },
  ])('uses the effective request-log setting for $name', async ({ yaml, initial, v8 }) => {
    const raw = yaml + '\nlogging-to-file: true\n';
    await handleDemoApiRequest('put', '/config.yaml', raw);

    const checkRequestLog = async (enabled: boolean) => {
      expect(await handleDemoApiRequest('get', '/request-log')).toEqual({ 'request-log': enabled });
      expect(await handleDemoApiRequest('get', '/config')).toMatchObject({ 'request-log': enabled });
      const list = await handleDemoApiRequest<{ files: unknown[] }>('get', '/request-error-logs');
      expect(list.files).toHaveLength(enabled ? 0 : 2);
    };

    await checkRequestLog(initial);
    await handleDemoApiRequest('put', '/request-log', { value: !initial });
    await checkRequestLog(!initial);
    const saved = parseYaml(await handleDemoApiRequest<string>('get', '/config.yaml'));
    expect(saved['logging-to-file']).toBe(true);
    expect(saved['ordinary-future-option']).toBe(parseYaml(raw)['ordinary-future-option']);
    if (v8) {
      expect(saved).not.toHaveProperty('request-log');
      expect(saved.observability.logs['request-log']).toBe(!initial);
      const maxFiles = parseYaml(raw).observability?.logs?.['error-logs-max-files'];
      expect(saved.observability.logs['error-logs-max-files']).toBe(maxFiles);
    } else {
      expect(saved['request-log']).toBe(!initial);
    }
  });

  it.each([
    'config-version: 9',
    'config-version: "8"',
    'observability: null',
    'observability: { logs: null }',
    'observability: { logs: { request-log: "false" } }',
    'request-log: []',
  ])('rejects invalid request-log YAML without replacing the saved demo configuration: %s', async (badYaml) => {
    const raw = 'port: 16743\n';
    await handleDemoApiRequest('put', '/config.yaml', raw);
    await expect(handleDemoApiRequest('put', '/config.yaml', badYaml)).rejects.toMatchObject({
      status: 400,
    });
    expect(await handleDemoApiRequest('get', '/config.yaml')).toBe(raw);
    expect(await handleDemoApiRequest('get', '/request-log')).toEqual({ 'request-log': false });
  });

  it.each([
    { token: 'yes', initial: true, v8: false },
    { token: 'Off', initial: false, v8: false },
    { token: "'yes'", initial: true, v8: false },
    { token: '"off"', initial: false, v8: false },
    { token: 'YES', initial: true, v8: true },
    { token: "'off'", initial: false, v8: true },
  ])('accepts the Core-compatible request-log spelling $token', async ({ token, initial, v8 }) => {
    const requestLog = `request-log: ${token}`;
    const raw = v8 ? `observability: { logs: { ${requestLog} } }\n` : `${requestLog}\n`;
    await handleDemoApiRequest('put', '/config.yaml', raw);
    expect(await handleDemoApiRequest('get', '/config.yaml')).toBe(raw);
    expect(await handleDemoApiRequest('get', '/request-log')).toEqual({ 'request-log': initial });
    await handleDemoApiRequest('put', '/request-log', { value: !initial });
    const updated = parseYaml(await handleDemoApiRequest<string>('get', '/config.yaml'));
    const actual = v8 ? updated.observability.logs : updated;
    expect(actual['request-log']).toBe(!initial);
    expect(await handleDemoApiRequest('get', '/request-log')).toEqual({ 'request-log': !initial });
  });

  it.each([
    {
      name: 'alias',
      yaml: 'defaults: &logs { request-log: yes, error-logs-max-files: 9 }\nobservability: { logs: *logs }\nother: *logs\n',
      original: { 'request-log': 'yes', 'error-logs-max-files': 9 },
    },
    {
      name: 'merge',
      yaml: 'defaults: &logs { request-log: yes, error-logs-max-files: 9 }\nobservability: { logs: { <<: *logs } }\nother: *logs\n',
      original: { 'request-log': 'yes', 'error-logs-max-files': 9 },
    },
    {
      name: 'anchored logs map',
      yaml: 'observability: { logs: &logs { request-log: yes, error-logs-max-files: 9 } }\nother: *logs\n',
      original: { 'request-log': 'yes', 'error-logs-max-files': 9 },
    },
    {
      name: 'alias on the enclosing parent',
      yaml: 'defaults: &settings { logs: { request-log: yes, error-logs-max-files: 9 } }\nobservability: *settings\nother: *settings\n',
      original: { logs: { 'request-log': 'yes', 'error-logs-max-files': 9 } },
    },
    {
      name: 'merge on the enclosing parent',
      yaml: 'defaults: &settings { logs: { request-log: yes, error-logs-max-files: 9 } }\nobservability: { <<: *settings }\nother: *settings\n',
      original: { logs: { 'request-log': 'yes', 'error-logs-max-files': 9 } },
    },
  ])('updates only the canonical request-log through $name', async ({ yaml, original }) => {
    const raw = 'request-log: false\n' + yaml;
    await handleDemoApiRequest('put', '/config.yaml', raw);
    expect(await handleDemoApiRequest('get', '/request-log')).toEqual({ 'request-log': true });
    expect(await handleDemoApiRequest('get', '/request-error-logs')).toEqual({ files: [] });

    await handleDemoApiRequest('put', '/request-log', { value: false });
    const updated = await handleDemoApiRequest<string>('get', '/config.yaml');
    const actual = parseYaml(updated, { merge: true });
    const before = parseYaml(raw, { merge: true });
    expect(actual.observability.logs).toEqual({
      'request-log': false,
      'error-logs-max-files': 9,
    });
    expect(actual.other).toEqual(original);
    expect(actual.defaults).toEqual(before.defaults);
    expect(await handleDemoApiRequest('get', '/request-log')).toEqual({ 'request-log': false });
    const errorLogs = await handleDemoApiRequest<{ files: unknown[] }>('get', '/request-error-logs');
    expect(errorLogs.files).toHaveLength(2);
  });

  it.each([
    { token: 'yes', decoded: 'yes' },
    { token: 'true', decoded: true },
  ])('isolates a legacy request-log shared anchor with $token', async ({ token, decoded }) => {
    const raw = [
      '# request-log heading',
      `request-log: &enabled ${token} # log switch`,
      'other: *enabled # original value',
      'another: *enabled',
      'unrelated: &enabled placeholder',
      'later: *enabled',
      '',
    ].join('\n');
    await handleDemoApiRequest('put', '/config.yaml', raw);
    expect(await handleDemoApiRequest('get', '/request-log')).toEqual({ 'request-log': true });

    await handleDemoApiRequest('put', '/request-log', { value: false });
    const saved = await handleDemoApiRequest<string>('get', '/config.yaml');
    expect(parseYaml(saved)).toEqual({
      'request-log': false,
      other: decoded,
      another: decoded,
      unrelated: 'placeholder',
      later: 'placeholder',
    });
    expect(saved).toContain('# request-log heading');
    expect(saved).toContain('# log switch');
    expect(saved).toContain('# original value');
    expect(await handleDemoApiRequest('get', '/request-log')).toEqual({ 'request-log': false });
    expect((await handleDemoApiRequest<{ files: unknown[] }>('get', '/request-error-logs')).files).toHaveLength(2);
  });

  it.each([
    'request-log: *enabled',
    'observability:\n  logs:\n    request-log: true',
    'observability:\n  logs:\n    request-log: *enabled',
  ])('preserves the inline note when updating %s', async (field) => {
    const raw = `ordinary-default: &enabled true\n${field} # operator note\n`;
    await handleDemoApiRequest('put', '/config.yaml', raw);
    await handleDemoApiRequest('put', '/request-log', { value: false });
    expect(await handleDemoApiRequest('get', '/config.yaml')).toContain('false # operator note');
    expect(await handleDemoApiRequest('get', '/request-log')).toEqual({ 'request-log': false });
  });

  it.each([
    ['defaults: &v { config-version: 8 }\n<<: *v', true],
    ['<<: [{ config-version: 8 }, { config-version: 9 }]', true],
    ['<<: { config-version: 9 }\nconfig-version: 8', true],
    ['<<: { config-version: 9 }', false],
    ['<<: [{ config-version: 9 }, { config-version: 8 }]', false],
    ['<<: { config-version: 08 }', false],
  ] as const)('uses the effective config-version in %s', async (raw, accepted) => {
    if (!accepted) {
      await expect(handleDemoApiRequest('put', '/config.yaml', raw)).rejects.toMatchObject({ status: 400 });
      return;
    }
    await handleDemoApiRequest('put', '/config.yaml', raw);
    await handleDemoApiRequest('put', '/request-log', { value: true });
    const saved = await handleDemoApiRequest<string>('get', '/config.yaml');
    expect(parseYaml(saved, { merge: true }).observability.logs['request-log']).toBe(true);
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
