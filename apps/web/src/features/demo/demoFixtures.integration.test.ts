import { describe, expect, it } from 'vitest';
import { getDemoAuthFiles, getDemoMonitoringAnalytics } from './demoFixtures';

describe('integrated synthetic demo fixtures', () => {
  it('keeps legacy scheduling/privacy fixtures alongside new account upgrade fixtures', () => {
    const response = getDemoAuthFiles();
    const names = response.files.map((file) => file.name);
    expect(response.total).toBe(response.files.length);
    expect(response.files.length).toBeGreaterThanOrEqual(48);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        'claude-default-04.json',
        'claude-pro-03.json',
        'codex-upgrade-demo.json',
        'claude-extra-usage-03.json',
      ])
    );
    expect(
      response.files.find((file) => file.name === 'claude-default-04.json')?.account_scheduling
        ?.warmup?.mature
    ).toBe(false);
  });
  it('keeps upstream request metadata and fork telemetry in the same bounded request clock', () => {
    const now = Date.now();
    const to = now - 120000;
    const page = getDemoMonitoringAnalytics({
      from_ms: to - 86400000,
      to_ms: to,
      now_ms: now,
      include: { events_page: { limit: 100 } },
    });
    const events = page.events?.items ?? [];
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.timestamp_ms <= to)).toBe(true);
    expect(events.map((event) => event.event_hash)).toEqual(
      expect.arrayContaining([
        'demo-event-gpt-model-matched',
        'demo-event-deepseek-reasoning-max',
        'demo-event-xai-free-usage-exhausted',
      ])
    );
    expect(
      events.some((event) => event.model === 'claude-opus-4-8-20260115-extended-thinking-preview')
    ).toBe(true);
    expect(events.some((event) => event.telemetry?.fast_context)).toBe(true);
  });
});
