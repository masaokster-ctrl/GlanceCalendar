import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, TEST_AGENT_TOKEN } from './testHelpers.js';
import { resetDuplicateTrackerForTests } from '../src/utils/duplicateTracker.js';
import type { DelayFn } from '../src/utils/delay.js';
import { fixedClock } from '../src/time/clock.js';
import { FakeCalendarClient } from '../src/calendar/calendarClient.js';
import { createCalendarService, type CalendarService } from '../src/calendar/calendarService.js';

const TOKEN = TEST_AGENT_TOKEN;

// 2026-07-21 (火) 10:00 JST を基準時刻とする(明日=2026-07-22)
const FIXED_NOW_ISO = '2026-07-21T01:00:00.000Z';

function createFastDelay(): { delayFn: DelayFn; calls: number[] } {
  const calls: number[] = [];
  const delayFn: DelayFn = async (ms) => {
    calls.push(ms);
  };
  return { delayFn, calls };
}

function connectedCalendarService(fake: FakeCalendarClient): () => Promise<CalendarService | null> {
  const service = createCalendarService(fake);
  return async () => service;
}

describe('POST /v1/chat/completions', () => {
  beforeEach(() => {
    resetDuplicateTrackerForTests();
  });

  it('returns a 200 OpenAI-compatible response for unsupported content', async () => {
    const app = createTestApp({ delayFn: createFastDelay().delayFn });
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'こんにちは' }],
        stream: false,
        some_unknown_field: 'whatever',
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      object: 'chat.completion',
      model: 'even-calendar-agent-probe',
      choices: [
        {
          index: 0,
          message: { role: 'assistant' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    expect(res.body.choices[0].message.content).toBe(
      '現在は、今日の予定、明日の予定、明日の15時の接続テスト予定の登録に対応しています。',
    );
    expect(typeof res.body.id).toBe('string');
    expect(typeof res.body.created).toBe('number');
  });

  it('defaults to non-stream when stream is omitted', async () => {
    const app = createTestApp({ delayFn: createFastDelay().delayFn });
    const res = await request(app).post('/v1/chat/completions').set('Authorization', `Bearer ${TOKEN}`).send({});

    expect(res.status).toBe(200);
    expect(res.body.object).toBe('chat.completion');
  });

  it('does not error on unexpected/unknown fields', async () => {
    const app = createTestApp({ delayFn: createFastDelay().delayFn });
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ totally_unknown_field: { nested: true }, another: [1, 2, 3] });

    expect(res.status).toBe(200);
  });

  it('streams OpenAI-compatible SSE chunks when stream is true', async () => {
    const app = createTestApp({ delayFn: createFastDelay().delayFn });
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ messages: [{ role: 'user', content: 'hi' }], stream: true });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);

    const lines = res.text
      .split('\n\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => line.replace(/^data: /, ''));

    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines[lines.length - 1]).toBe('[DONE]');

    const chunks = lines.slice(0, -1).map((line) => JSON.parse(line));
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant' });
    expect(typeof chunks[1].choices[0].delta.content).toBe('string');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');

    for (const chunk of chunks) {
      expect(chunk.object).toBe('chat.completion.chunk');
      expect(chunk.model).toBe('even-calendar-agent-probe');
    }
  });

  describe('ENABLE_PROBE_TESTS gating', () => {
    it('does not trigger delay test phrases when disabled (default)', async () => {
      const { delayFn, calls } = createFastDelay();
      const app = createTestApp({ delayFn, enableProbeTests: false });

      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: '遅延テスト1秒' }] });

      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).not.toContain('遅延テスト');
      expect(calls).toEqual([0]);
    });

    it('does not trigger display-length phrase when disabled (default)', async () => {
      const { delayFn } = createFastDelay();
      const app = createTestApp({ delayFn, enableProbeTests: false });

      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: '表示長テスト' }] });

      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).not.toContain('表示長テストです');
    });

    it.each(['遅延テスト1秒', '遅延テスト3秒', '遅延テスト5秒', '遅延テスト10秒'])(
      'recognizes "%s" when enabled and requests the correct delay',
      async (phrase) => {
        const { delayFn, calls } = createFastDelay();
        const app = createTestApp({ delayFn, enableProbeTests: true });

        const res = await request(app)
          .post('/v1/chat/completions')
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({ model: 'even-ai', messages: [{ role: 'user', content: phrase }], stream: false });

        expect(res.status).toBe(200);
        expect(res.body.choices[0].message.content).toContain('遅延テストに成功しました');
        expect(calls).toHaveLength(1);
      },
    );

    it('returns the display-length content with real newline characters when enabled', async () => {
      const { delayFn } = createFastDelay();
      const app = createTestApp({ delayFn, enableProbeTests: true });
      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: '表示長テスト' }] });

      const content: string = res.body.choices[0].message.content;
      expect(content.split('\n').length).toBeGreaterThan(1);
      expect(content).toContain('表示長テストです。');
    });
  });

  describe('calendar commands: not connected', () => {
    it('returns the not-connected message for today-list', async () => {
      const app = createTestApp({ delayFn: createFastDelay().delayFn });
      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: '今日の予定を教えて' }] });

      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).toBe('Googleカレンダーが未連携です。セットアップ画面で連携してください。');
    });

    it('returns the not-connected message for create-fixed-event', async () => {
      const app = createTestApp({ delayFn: createFastDelay().delayFn });
      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: '明日の15時に接続テスト予定を作って' }] });

      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).toBe('Googleカレンダーが未連携です。セットアップ画面で連携してください。');
    });
  });

  describe('calendar commands: connected', () => {
    it('lists today events', async () => {
      const fake = new FakeCalendarClient();
      fake.listEventsResult = [
        { eventId: 'a', summary: '打ち合わせ', startDateTime: '2026-07-21T10:00:00+09:00', startDate: null, status: 'confirmed' },
      ];
      const app = createTestApp({
        delayFn: createFastDelay().delayFn,
        clock: fixedClock(FIXED_NOW_ISO),
        resolveCalendarService: connectedCalendarService(fake),
      });

      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: '今日の予定を教えて' }] });

      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).toBe('10時 打ち合わせ');
    });

    it('lists today events via the agent alias command and calls Calendar API exactly once', async () => {
      const fake = new FakeCalendarClient();
      fake.listEventsResult = [
        { eventId: 'a', summary: '打ち合わせ', startDateTime: '2026-07-21T10:00:00+09:00', startDate: null, status: 'confirmed' },
      ];
      const app = createTestApp({
        delayFn: createFastDelay().delayFn,
        clock: fixedClock(FIXED_NOW_ISO),
        resolveCalendarService: connectedCalendarService(fake),
      });

      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: 'エージェント、今日' }] });

      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).toBe('10時 打ち合わせ');
      expect(fake.listCallCount).toBe(1);
    });

    it('lists tomorrow events via the agent alias command over SSE', async () => {
      const fake = new FakeCalendarClient();
      fake.listEventsResult = [];
      const app = createTestApp({
        delayFn: createFastDelay().delayFn,
        clock: fixedClock(FIXED_NOW_ISO),
        resolveCalendarService: connectedCalendarService(fake),
      });

      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: 'マイエージェント明日' }], stream: true });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/event-stream/);
      const lines = res.text
        .split('\n\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => line.replace(/^data: /, ''));
      expect(lines[lines.length - 1]).toBe('[DONE]');
      const chunks = lines.slice(0, -1).map((line) => JSON.parse(line));
      expect(chunks[1].choices[0].delta.content).toBe('明日の予定はありません。');
      expect(fake.listCallCount).toBe(1);
    });

    it('asks for confirmation via the agent alias create-fixed-event command without writing to Calendar', async () => {
      const fake = new FakeCalendarClient();
      const app = createTestApp({
        delayFn: createFastDelay().delayFn,
        clock: fixedClock(FIXED_NOW_ISO),
        resolveCalendarService: connectedCalendarService(fake),
      });

      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: 'エージェント、テスト登録' }] });

      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).toBe('明日の15時から16時まで、接続テスト予定を登録しますか？');
      expect(fake.insertCallCount).toBe(0);
    });

    it('lists today events via the numbered command and calls Calendar API exactly once', async () => {
      const fake = new FakeCalendarClient();
      fake.listEventsResult = [];
      const app = createTestApp({
        delayFn: createFastDelay().delayFn,
        clock: fixedClock(FIXED_NOW_ISO),
        resolveCalendarService: connectedCalendarService(fake),
      });

      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: '接続テスト一' }] });

      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).toBe('今日の予定はありません。');
      expect(fake.listCallCount).toBe(1);
    });

    it('lists tomorrow events via the numbered command and calls Calendar API exactly once', async () => {
      const fake = new FakeCalendarClient();
      fake.listEventsResult = [];
      const app = createTestApp({
        delayFn: createFastDelay().delayFn,
        clock: fixedClock(FIXED_NOW_ISO),
        resolveCalendarService: connectedCalendarService(fake),
      });

      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: '接続テスト2' }] });

      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).toBe('明日の予定はありません。');
      expect(fake.listCallCount).toBe(1);
    });

    it('asks for confirmation via the numbered create-fixed-event command without writing to Calendar', async () => {
      const fake = new FakeCalendarClient();
      const app = createTestApp({
        delayFn: createFastDelay().delayFn,
        clock: fixedClock(FIXED_NOW_ISO),
        resolveCalendarService: connectedCalendarService(fake),
      });

      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: '接続テストさん' }], stream: true });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/event-stream/);
      const lines = res.text
        .split('\n\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => line.replace(/^data: /, ''));
      expect(lines[lines.length - 1]).toBe('[DONE]');
      const chunks = lines.slice(0, -1).map((line) => JSON.parse(line));
      expect(chunks[1].choices[0].delta.content).toBe('明日の15時から16時まで、接続テスト予定を登録しますか？');
      expect(fake.insertCallCount).toBe(0);
    });

    it('does not log the numbered command utterance content', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const fake = new FakeCalendarClient();
      fake.listEventsResult = [];
      const app = createTestApp({
        delayFn: createFastDelay().delayFn,
        clock: fixedClock(FIXED_NOW_ISO),
        resolveCalendarService: connectedCalendarService(fake),
      });

      await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: '接続テスト一' }] });

      const allLogText = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allLogText).not.toContain('接続テスト一');

      logSpy.mockRestore();
    });

    it('does not log the agent alias utterance content', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const fake = new FakeCalendarClient();
      fake.listEventsResult = [];
      const app = createTestApp({
        delayFn: createFastDelay().delayFn,
        clock: fixedClock(FIXED_NOW_ISO),
        resolveCalendarService: connectedCalendarService(fake),
      });

      await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: 'エージェント、今日' }] });

      const allLogText = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allLogText).not.toContain('エージェント、今日');
      expect(allLogText).not.toContain('エージェント');

      logSpy.mockRestore();
    });

    it('reports no events for tomorrow', async () => {
      const fake = new FakeCalendarClient();
      fake.listEventsResult = [];
      const app = createTestApp({
        delayFn: createFastDelay().delayFn,
        clock: fixedClock(FIXED_NOW_ISO),
        resolveCalendarService: connectedCalendarService(fake),
      });

      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: '明日の予定を教えて' }] });

      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).toBe('明日の予定はありません。');
    });

    it('asks for confirmation on the fixed-event phrase without creating the event yet', async () => {
      const fake = new FakeCalendarClient();
      const app = createTestApp({
        delayFn: createFastDelay().delayFn,
        clock: fixedClock(FIXED_NOW_ISO),
        resolveCalendarService: connectedCalendarService(fake),
      });

      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: '明日の15時に接続テスト予定を作って' }] });

      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).toBe('明日の15時から16時まで、接続テスト予定を登録しますか？');
      expect(fake.insertCallCount).toBe(0);
    });

    it('creates the event only after confirmation with 登録して', async () => {
      const fake = new FakeCalendarClient();
      const clock = fixedClock(FIXED_NOW_ISO);
      const resolveCalendarService = connectedCalendarService(fake);
      const app = createTestApp({ delayFn: createFastDelay().delayFn, clock, resolveCalendarService });

      await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: '明日15時に接続テスト予定を入れて' }] });

      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: '登録して' }] });

      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).toBe('Googleカレンダーに登録しました。');
      expect(fake.insertCallCount).toBe(1);
    });

    it('cancels the pending event with いいえ without calling Calendar API', async () => {
      const fake = new FakeCalendarClient();
      const clock = fixedClock(FIXED_NOW_ISO);
      const resolveCalendarService = connectedCalendarService(fake);
      const app = createTestApp({ delayFn: createFastDelay().delayFn, clock, resolveCalendarService });

      await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: '明日の午後3時に接続テスト予定を作って' }] });

      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: 'いいえ' }] });

      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).toBe('登録をキャンセルしました。');
      expect(fake.insertCallCount).toBe(0);
    });

    it('reports no pending event when confirming without a prior create request', async () => {
      const fake = new FakeCalendarClient();
      const app = createTestApp({
        delayFn: createFastDelay().delayFn,
        clock: fixedClock(FIXED_NOW_ISO),
        resolveCalendarService: connectedCalendarService(fake),
      });

      const res = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: 'はい' }] });

      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).toBe('確認待ちの予定はありません。');
    });

    it('does not double-create when the same confirmation arrives twice concurrently', async () => {
      const fake = new FakeCalendarClient();
      const clock = fixedClock(FIXED_NOW_ISO);
      const resolveCalendarService = connectedCalendarService(fake);
      const app = createTestApp({ delayFn: createFastDelay().delayFn, clock, resolveCalendarService });

      await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ messages: [{ role: 'user', content: '明日の15時に接続テスト予定を作って' }] });

      const [res1, res2] = await Promise.all([
        request(app)
          .post('/v1/chat/completions')
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({ messages: [{ role: 'user', content: 'はい' }] }),
        request(app)
          .post('/v1/chat/completions')
          .set('Authorization', `Bearer ${TOKEN}`)
          .send({ messages: [{ role: 'user', content: 'はい' }] }),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(fake.insertCallCount).toBeLessThanOrEqual(1);

      const contents = [res1.body.choices[0].message.content, res2.body.choices[0].message.content];
      expect(contents.filter((c) => c === 'Googleカレンダーに登録しました。').length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('structured logging safety', () => {
    it('never logs conversation content, Authorization value, or Bearer token', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const app = createTestApp({ delayFn: createFastDelay().delayFn });

      await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ model: 'even-ai', messages: [{ role: 'user', content: 'とても私的な内容です' }], stream: false });

      const allLogText = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(allLogText).not.toContain('とても私的な内容です');
      expect(allLogText).not.toContain(TOKEN);
      expect(allLogText).not.toContain(`Bearer ${TOKEN}`);

      logSpy.mockRestore();
    });

    it('logs a chat_completions_response_sent event with only the documented safe fields', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const app = createTestApp({ delayFn: createFastDelay().delayFn });

      await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .set('X-Cloud-Trace-Context', 'abc123/1;o=1')
        .send({ model: 'even-ai', messages: [{ role: 'user', content: '今日の予定を教えて' }], stream: false });

      const entry = logSpy.mock.calls
        .map(([line]) => JSON.parse(String(line)))
        .find((e) => e.event === 'chat_completions_response_sent');

      expect(entry).toBeDefined();
      expect(entry.commandType).toBe('today-list');
      expect(entry.oauthConnected).toBe(false);
      expect(entry.traceId).toBe('abc123');
      expect(entry.httpStatus).toBe(200);
      expect(entry.responseType).toBe('json');
      expect(typeof entry.requestFingerprint).toBe('string');
      expect(entry.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof entry.durationMs).toBe('number');
      expect(typeof entry.duplicateDetected).toBe('boolean');
      expect(typeof entry.instanceId).toBe('string');

      const forbiddenKeys = [
        'content',
        'assistantContent',
        'summary',
        'startDateTime',
        'endDateTime',
        'eventId',
        'operationId',
        'code',
        'accessToken',
        'refreshToken',
        'clientSecret',
        'setupAdminToken',
        'authorization',
        'cookie',
      ];
      for (const key of forbiddenKeys) {
        expect(Object.prototype.hasOwnProperty.call(entry, key)).toBe(false);
      }

      logSpy.mockRestore();
    });

    it('marks duplicateDetected true for a near-simultaneous repeat of the same request', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const clock = fixedClock(FIXED_NOW_ISO);
      const app = createTestApp({ delayFn: createFastDelay().delayFn, clock });
      const payload = { model: 'even-ai', messages: [{ role: 'user', content: 'こんにちは' }], stream: false };

      await request(app).post('/v1/chat/completions').set('Authorization', `Bearer ${TOKEN}`).send(payload);
      await request(app).post('/v1/chat/completions').set('Authorization', `Bearer ${TOKEN}`).send(payload);

      const entries = logSpy.mock.calls
        .map(([line]) => JSON.parse(String(line)))
        .filter((e) => e.event === 'chat_completions_response_sent');

      expect(entries).toHaveLength(2);
      expect(entries[0].duplicateDetected).toBe(false);
      expect(entries[1].duplicateDetected).toBe(true);

      logSpy.mockRestore();
    });
  });
});

describe('POST /v1/chat/completions payload limits and auth edge cases', () => {
  it('returns 413 for a body larger than 1MB', async () => {
    const app = createTestApp({ delayFn: createFastDelay().delayFn });
    const bigContent = 'a'.repeat(1024 * 1024 + 100);
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ messages: [{ role: 'user', content: bigContent }] });

    expect(res.status).toBe(413);
  });

  it('returns 401 for an invalid Bearer token', async () => {
    const app = createTestApp({ delayFn: createFastDelay().delayFn });
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer wrong-token')
      .send({ messages: [] });

    expect(res.status).toBe(401);
  });

  it('returns 200 for unknown top-level fields', async () => {
    const app = createTestApp({ delayFn: createFastDelay().delayFn });
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ unknown_field_xyz: true, messages: [] });

    expect(res.status).toBe(200);
  });
});
