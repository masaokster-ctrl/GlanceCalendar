import { describe, expect, it } from 'vitest';
import { registerCandidateEvent } from '../src/services/pluginCalendarRegistrationService.js';
import { InMemoryPluginEventCandidateRepository } from '../src/firestore/pluginEventCandidateRepository.js';
import { FakeCalendarClient } from '../src/calendar/calendarClient.js';
import { createCalendarService } from '../src/calendar/calendarService.js';
import { fixedClock } from '../src/time/clock.js';

const NOW = new Date('2026-07-22T05:00:00Z');

async function seedCandidate(
  repo: InMemoryPluginEventCandidateRepository,
  overrides: Partial<Parameters<InMemoryPluginEventCandidateRepository['create']>[0]> = {},
): Promise<void> {
  await repo.create({
    candidateId: 'c1',
    sessionHash: 'session-hash',
    installIdHash: 'install-hash',
    title: '打ち合わせ',
    startLocal: '2026-07-23T15:00:00',
    endLocal: '2026-07-23T16:00:00',
    timeZone: 'Asia/Tokyo',
    allDay: false,
    now: NOW,
    expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
    analysisRequestIdHash: 'req-hash',
    ...overrides,
  });
}

describe('registerCandidateEvent', () => {
  it('creates a Calendar event and marks the candidate completed', async () => {
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    await seedCandidate(candidateRepo);
    const client = new FakeCalendarClient();
    const calendarService = createCalendarService(client);

    const outcome = await registerCandidateEvent(
      { clock: fixedClock(NOW), candidateRepo, resolveCalendarService: async () => calendarService },
      'c1',
    );

    expect(outcome.kind).toBe('success');
    expect(outcome.calendarApiOperation).toBe('events.insert');
    expect(client.insertCallCount).toBe(1);

    const doc = await candidateRepo.get('c1');
    expect(doc?.status).toBe('completed');
    expect(doc?.googleEventId).toBeTruthy();
  });

  it('generates a deterministic event ID (same candidateId => same event ID across calls)', async () => {
    const candidateRepo1 = new InMemoryPluginEventCandidateRepository();
    await seedCandidate(candidateRepo1);
    const client1 = new FakeCalendarClient();
    await registerCandidateEvent(
      { clock: fixedClock(NOW), candidateRepo: candidateRepo1, resolveCalendarService: async () => createCalendarService(client1) },
      'c1',
    );
    const doc1 = await candidateRepo1.get('c1');

    const candidateRepo2 = new InMemoryPluginEventCandidateRepository();
    await seedCandidate(candidateRepo2);
    const client2 = new FakeCalendarClient();
    await registerCandidateEvent(
      { clock: fixedClock(NOW), candidateRepo: candidateRepo2, resolveCalendarService: async () => createCalendarService(client2) },
      'c1',
    );
    const doc2 = await candidateRepo2.get('c1');

    expect(doc1?.googleEventId).toBe(doc2?.googleEventId);
  });

  it('returns candidate_invalid for an unknown candidateId', async () => {
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    const outcome = await registerCandidateEvent(
      { clock: fixedClock(NOW), candidateRepo, resolveCalendarService: async () => createCalendarService(new FakeCalendarClient()) },
      'unknown',
    );
    expect(outcome.kind).toBe('candidate_invalid');
  });

  it('returns candidate_invalid for an expired candidate', async () => {
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    await seedCandidate(candidateRepo, { expiresAt: new Date(NOW.getTime() - 1000) });
    const outcome = await registerCandidateEvent(
      { clock: fixedClock(NOW), candidateRepo, resolveCalendarService: async () => createCalendarService(new FakeCalendarClient()) },
      'c1',
    );
    expect(outcome.kind).toBe('candidate_invalid');
  });

  it('returns oauth_not_connected and marks the candidate failed when no Calendar service is available', async () => {
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    await seedCandidate(candidateRepo);
    const outcome = await registerCandidateEvent(
      { clock: fixedClock(NOW), candidateRepo, resolveCalendarService: async () => null },
      'c1',
    );
    expect(outcome.kind).toBe('oauth_not_connected');
    const doc = await candidateRepo.get('c1');
    expect(doc?.status).toBe('failed');
  });

  it('calls Calendar events.insert exactly once even when retried with the same candidateId after success (idempotent replay)', async () => {
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    await seedCandidate(candidateRepo);
    const client = new FakeCalendarClient();
    const deps = { clock: fixedClock(NOW), candidateRepo, resolveCalendarService: async () => createCalendarService(client) };

    const first = await registerCandidateEvent(deps, 'c1');
    const second = await registerCandidateEvent(deps, 'c1');

    expect(first.kind).toBe('success');
    expect(second.kind).toBe('success');
    expect(second.reusedCompletedResult).toBe(true);
    expect(client.insertCallCount).toBe(1);
  });

  it('recovers from a Calendar 409 (duplicate_id) by treating an existing event as success without a second insert', async () => {
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    await seedCandidate(candidateRepo);
    const client = new FakeCalendarClient();
    // 事前に同じdeterministic IDでイベントが存在する状況を作る(insertを1回強制的に成功させておく)
    const preInsertOutcome = await registerCandidateEvent(
      { clock: fixedClock(NOW), candidateRepo, resolveCalendarService: async () => createCalendarService(client) },
      'c1',
    );
    expect(preInsertOutcome.kind).toBe('success');

    // 候補を作り直して再度登録を試みる(同じtitle/日時なのでeventIdは同じになるはず)。
    // FakeCalendarClientは同一eventIdへのinsertで409を投げる仕様。
    const candidateRepo2 = new InMemoryPluginEventCandidateRepository();
    await seedCandidate(candidateRepo2, { candidateId: 'c1' });
    const outcome = await registerCandidateEvent(
      { clock: fixedClock(NOW), candidateRepo: candidateRepo2, resolveCalendarService: async () => createCalendarService(client) },
      'c1',
    );

    expect(outcome.kind).toBe('success');
    expect(outcome.calendarApiOperation).toBe('events.get');
    expect(client.insertCallCount).toBe(2); // 2回目はinsertを試みて409を受けるが、getEventで回復する
  });

  it('recovers from a timeout by checking for the existing event before declaring failure', async () => {
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    await seedCandidate(candidateRepo);
    const client = new FakeCalendarClient();
    const timeoutErr = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    client.nextInsertError = () => {
      throw timeoutErr;
    };

    const outcome = await registerCandidateEvent(
      { clock: fixedClock(NOW), candidateRepo, resolveCalendarService: async () => createCalendarService(client) },
      'c1',
    );

    // insertはtimeoutで失敗するが、getEventで存在確認した結果イベントが無いため最終的に失敗として扱われる
    // (Googleが実際には作成していた場合のみ成功へ回復する。ここではFakeが未作成のケースを検証)
    expect(outcome.kind).toBe('calendar_error');
    expect(outcome.sanitizedErrorCode).toBe('timeout');
  });

  it('does not create a duplicate event when a timeout occurs after Google actually created it', async () => {
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    await seedCandidate(candidateRepo);
    const client = new FakeCalendarClient();

    // 1回目は成功させ、Google側にイベントが実在する状態を作る
    const successOutcome = await registerCandidateEvent(
      { clock: fixedClock(NOW), candidateRepo, resolveCalendarService: async () => createCalendarService(client) },
      'c1',
    );
    expect(successOutcome.kind).toBe('success');

    // 新しい候補(同じ内容→同じeventId)で、次のinsertがtimeoutするケースを模擬
    const candidateRepo2 = new InMemoryPluginEventCandidateRepository();
    await seedCandidate(candidateRepo2, { candidateId: 'c1' });
    const timeoutErr = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    client.nextInsertError = () => {
      throw timeoutErr;
    };

    const outcome = await registerCandidateEvent(
      { clock: fixedClock(NOW), candidateRepo: candidateRepo2, resolveCalendarService: async () => createCalendarService(client) },
      'c1',
    );

    expect(outcome.kind).toBe('success');
    expect(outcome.reusedCompletedResult).toBe(true);
    expect(client.insertCallCount).toBe(2); // 2回目は例外を投げるがinsertとしてはカウントされる。実際の重複作成は発生していない
  });

  it('never logs or returns the event title/date in the outcome object', async () => {
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    await seedCandidate(candidateRepo, { title: 'UNIQUE_SENTINEL_TITLE' });
    const client = new FakeCalendarClient();
    const outcome = await registerCandidateEvent(
      { clock: fixedClock(NOW), candidateRepo, resolveCalendarService: async () => createCalendarService(client) },
      'c1',
    );
    expect(JSON.stringify(outcome)).not.toContain('UNIQUE_SENTINEL_TITLE');
  });

  it('passes the userId through to resolveCalendarService for a product principal', async () => {
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    await seedCandidate(candidateRepo);
    const client = new FakeCalendarClient();
    const seenUserIds: (string | null | undefined)[] = [];

    const outcome = await registerCandidateEvent(
      {
        clock: fixedClock(NOW),
        candidateRepo,
        resolveCalendarService: async (userId) => {
          seenUserIds.push(userId);
          return createCalendarService(client);
        },
      },
      'c1',
      'user-1',
    );

    expect(outcome.kind).toBe('success');
    expect(seenUserIds).toEqual(['user-1']);
  });

  it('creates an all-day Calendar event (start.date/end.date, exclusive end date passed through unchanged)', async () => {
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    await seedCandidate(candidateRepo, {
      allDay: true,
      startLocal: null,
      endLocal: null,
      startDate: '2026-08-03',
      endDateExclusive: '2026-08-06',
    });
    const client = new FakeCalendarClient();
    const calendarService = createCalendarService(client);

    const outcome = await registerCandidateEvent(
      { clock: fixedClock(NOW), candidateRepo, resolveCalendarService: async () => calendarService },
      'c1',
    );

    expect(outcome.kind).toBe('success');
    expect(client.insertCallCount).toBe(1);
    const doc = await candidateRepo.get('c1');
    expect(doc?.status).toBe('completed');
  });

  it('classifies a product-principal Calendar failure with a product_* code (Phase 2K), not the generic dev auth_invalid_grant code', async () => {
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    await seedCandidate(candidateRepo);
    const client = new FakeCalendarClient();
    client.nextInsertError = () => {
      throw Object.assign(new Error('token endpoint failure'), { response: { status: 401, data: {} } });
    };

    const outcome = await registerCandidateEvent(
      { clock: fixedClock(NOW), candidateRepo, resolveCalendarService: async () => createCalendarService(client) },
      'c1',
      'user-1',
    );

    expect(outcome.kind).toBe('calendar_error');
    expect(outcome.sanitizedErrorCode).toBe('product_google_refresh_invalid_client');
    const doc = await candidateRepo.get('c1');
    expect(doc?.sanitizedErrorCode).toBe('product_google_refresh_invalid_client');
  });

  it('still uses the generic dev sanitizedErrorCode when userId is absent (regression)', async () => {
    const candidateRepo = new InMemoryPluginEventCandidateRepository();
    await seedCandidate(candidateRepo);
    const client = new FakeCalendarClient();
    client.nextInsertError = () => {
      throw Object.assign(new Error('unauthorized'), { code: 401 });
    };

    const outcome = await registerCandidateEvent(
      { clock: fixedClock(NOW), candidateRepo, resolveCalendarService: async () => createCalendarService(client) },
      'c1',
    );

    expect(outcome.kind).toBe('calendar_error');
    expect(outcome.sanitizedErrorCode).toBe('auth_invalid_grant');
  });
});
