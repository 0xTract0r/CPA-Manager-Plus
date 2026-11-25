import { describe, expect, it } from 'vitest';
import { parseLogLine } from './logParsing';

describe('parseLogLine timestamp prefix', () => {
  it.each([
    ['2026-11-25 00:15:08 +08:00', '--------', undefined],
    ['2026-11-25 00:15:08 -03:30', 'face1234', 'face1234'],
    ['2026-11-25 00:15:08', 'face1234', 'face1234'],
    ['2026-11-25T00:15:08.123', 'face1234', 'face1234'],
    ['2026-11-25T00:15:08.123Z', 'face1234', 'face1234'],
    ['2026-11-25T00:15:08.123+08:00', 'face1234', 'face1234'],
  ])('separates the %s timestamp from the structured record', (timestamp, id, requestId) => {
    const message = 'Batch started at 2026-11-24T16:14:00Z\nFinished at 2026-11-25 00:14:59 +08:00';
    const raw = `[${timestamp}] [${id}] [info ] [main.go:635] ${message}`;

    expect(parseLogLine(raw)).toMatchObject({
      raw,
      timestamp,
      requestId,
      level: 'info',
      source: 'main.go:635',
      message,
    });
  });

  it('retains a separate offset at the start of the message after a bare timestamp', () => {
    const raw = '2026-11-25 00:15:08 +08:00 is the scheduled offset';
    expect(parseLogLine(raw)).toMatchObject({
      timestamp: '2026-11-25 00:15:08',
      message: '+08:00 is the scheduled offset',
    });
  });

  it('keeps a spaced offset and closing bracket in the body of a bare timestamp', () => {
    const raw = '2026-11-25 00:15:08 +08:00] 正文';
    expect(parseLogLine(raw)).toMatchObject({
      raw,
      timestamp: '2026-11-25 00:15:08',
      message: '+08:00] 正文',
    });
  });

  it('leaves an unstructured message containing a timestamp intact', () => {
    const raw = 'Replay started\n2026-11-25 00:14:59 +08:00';
    expect(parseLogLine(raw)).toMatchObject({ timestamp: undefined, message: raw });
  });
});
