import { describe, expect, it } from 'vitest';
import { updateCalendarEvent, deleteCalendarEvent, type MutationDeps } from '../src/services/pluginCalendarEventMutationService.js';
import { FakeCalendarClient, type CalendarEventFullDetail } from '../src/calendar/calendarClient.js';
import { createCalendarService } from '../src/calendar/calendarService.js';
import { InMemoryIdempotencyRepository } from '../src/firestore/idempotencyRepository.js';
import { fixedClock } from '../src/time/clock.js';

const NOW = new Date('2026-07-23T05:00:00Z'); // 2026-07-23 14:00 JST
const CALENDAR_ID = 'primary';

function timedDetail(overrides: Partial<CalendarEventFullDetail> = {}): CalendarEventFullDetail {
  return {
    eventId: 'evt-1',
    status: 'confirmed',
    summary: '打ち合わせ',
    description: null,
    location: '会議室A',
    startDateTime: '2026-07-23T15:00:00+09:00',
    startDate: null,
    endDateTime: '2026-07-23T16:00:00+09:00',
    endDate: null,
    attendees: null,
    conferenceJoinUrl: null,
    etag: '"etag-1"',
    ...overrides,
  };
}

function allDayDetail(overrides: Partial<CalendarEventFullDetail> = {}): CalendarEventFullDetail {
  return {
    eventId: 'evt-allday',
    status: 'confirmed',
    summary: '休暇',
    description: null,
    location: null,
    startDateTime: null,
    startDate: '2026-07-23',
    endDateTime: null,
    endDate: '2026-07-24',
    attendees: null,
    conferenceJoinUrl: null,
    etag: '"etag-allday"',
    ...overrides,
  };
}

function makeDeps(client: FakeCalendarClient, opts: { idempotencyRepo?: InMemoryIdempotencyRepository } = {}): MutationDeps {
  return {
    clock: fixedClock(NOW),
    idempotencyRepo: opts.idempotencyRepo ?? new InMemoryIdempotencyRepository(),
    calendarId: CALENDAR_ID,
    resolveCalendarService: async () => createCalendarService(client),
  };
}

describe('updateCalendarEvent', () => {
  it('changes only the specified fields (title), leaving location/description/timing untouched', async () => {
    const client = new FakeCalendarClient();
    client.eventStore.set('evt-1', timedDetail());
    const deps = makeDeps(client);

    const outcome = await updateCalendarEvent(deps, { idempotencyKey: 'key-1', eventId: 'evt-1', fields: { title: '新タイトル' } });

    expect(outcome.kind).toBe('success');
    expect(client.patchCallCount).toBe(1);
    const sentParams = client.patchEventParamsSeen[0];
    expect(sentParams?.summary).toBe('新タイトル');
    expect(sentParams?.start).toBeUndefined();
    expect(sentParams?.end).toBeUndefined();
    expect(sentParams?.location).toBeUndefined();

    const stored = client.eventStore.get('evt-1');
    expect(stored?.location).toBe('会議室A'); // 未指定フィールドは維持される
  });

  it('merges a partial timed update (only endLocal given) with the current startLocal', async () => {
    const client = new FakeCalendarClient();
    client.eventStore.set('evt-1', timedDetail());
    const deps = makeDeps(client);

    const outcome = await updateCalendarEvent(deps, { idempotencyKey: 'key-1', eventId: 'evt-1', fields: { endLocal: '2026-07-23T17:00:00' } });

    expect(outcome.kind).toBe('success');
    const sentParams = client.patchEventParamsSeen[0];
    expect(sentParams?.start).toEqual({ dateTime: '2026-07-23T15:00:00+09:00', timeZone: 'Asia/Tokyo' });
    expect(sentParams?.end).toEqual({ dateTime: '2026-07-23T17:00:00+09:00', timeZone: 'Asia/Tokyo' });
  });

  it('rejects an update where the merged end is not after start (invalid_range)', async () => {
    const client = new FakeCalendarClient();
    client.eventStore.set('evt-1', timedDetail());
    const deps = makeDeps(client);

    const outcome = await updateCalendarEvent(deps, {
      idempotencyKey: 'key-1',
      eventId: 'evt-1',
      fields: { startLocal: '2026-07-23T18:00:00', endLocal: '2026-07-23T17:00:00' },
    });

    expect(outcome.kind).toBe('invalid_range');
    expect(client.patchCallCount).toBe(0);
  });

  it('updates an all-day event, merging only the provided date onto the other', async () => {
    const client = new FakeCalendarClient();
    client.eventStore.set('evt-allday', allDayDetail());
    const deps = makeDeps(client);

    const outcome = await updateCalendarEvent(deps, {
      idempotencyKey: 'key-1',
      eventId: 'evt-allday',
      fields: { endDateExclusive: '2026-07-26' },
    });

    expect(outcome.kind).toBe('success');
    const sentParams = client.patchEventParamsSeen[0];
    expect(sentParams?.start).toEqual({ date: '2026-07-23' });
    expect(sentParams?.end).toEqual({ date: '2026-07-26' });
  });

  it('rejects mixing timed fields with an all-day target (type-crossing partial update)', async () => {
    const client = new FakeCalendarClient();
    client.eventStore.set('evt-1', timedDetail());
    const deps = makeDeps(client);

    const outcome = await updateCalendarEvent(deps, {
      idempotencyKey: 'key-1',
      eventId: 'evt-1',
      fields: { allDay: true, startLocal: '2026-07-23T15:00:00' },
    });

    expect(outcome.kind).toBe('invalid_range');
  });

  it('returns not_found when the event no longer exists (already deleted)', async () => {
    const client = new FakeCalendarClient();
    const deps = makeDeps(client);
    const outcome = await updateCalendarEvent(deps, { idempotencyKey: 'key-1', eventId: 'missing', fields: { title: 'x' } });
    expect(outcome.kind).toBe('not_found');
  });

  it('returns conflict on a 412 from events.patch (etag mismatch) with a distinct sanitizedErrorCode for a product principal', async () => {
    const client = new FakeCalendarClient();
    client.eventStore.set('evt-1', timedDetail({ etag: '"server-etag"' }));
    // クライアントが古いetagで送るケースをシミュレート: patchEvent自体は常に一致チェックするため、
    // 直接nextPatchErrorで412を注入する。
    client.nextPatchEventError = () => {
      throw Object.assign(new Error('conflict'), { code: 412 });
    };
    const deps = makeDeps(client);

    const devOutcome = await updateCalendarEvent(deps, { idempotencyKey: 'key-dev', eventId: 'evt-1', fields: { title: 'x' } });
    expect(devOutcome.kind).toBe('conflict');

    client.nextPatchEventError = () => {
      // classifyProductCalendarError()はgoogleapisの実エラー形(response.status)しか見ないため、
      // その形で注入する(FakeCalendarClientのpatchEvent自体が投げる{code:412}とは別ケース)。
      throw Object.assign(new Error('conflict'), { response: { status: 412 } });
    };
    const productOutcome = await updateCalendarEvent(deps, { idempotencyKey: 'key-product', eventId: 'evt-1', fields: { title: 'x' }, userId: 'user-1' });
    expect(productOutcome.kind).toBe('conflict');
    expect(productOutcome.sanitizedErrorCode).toBe('product_calendar_conflict');
    expect(devOutcome.sanitizedErrorCode).not.toBe('product_calendar_conflict');
  });

  it('classifies a product-principal Calendar failure with a product_* code, not the generic dev code (regression)', async () => {
    const client = new FakeCalendarClient();
    client.eventStore.set('evt-1', timedDetail());
    client.nextPatchEventError = () => {
      throw Object.assign(new Error('token endpoint failure'), { response: { status: 401, data: {} } });
    };
    const deps = makeDeps(client);

    const outcome = await updateCalendarEvent(deps, { idempotencyKey: 'key-1', eventId: 'evt-1', fields: { title: 'x' }, userId: 'user-1' });

    expect(outcome.kind).toBe('calendar_error');
    expect(outcome.sanitizedErrorCode).toBe('product_google_refresh_invalid_client');
  });

  it('still uses the generic dev sanitizedErrorCode when userId is absent (regression)', async () => {
    const client = new FakeCalendarClient();
    client.eventStore.set('evt-1', timedDetail());
    client.nextPatchEventError = () => {
      throw Object.assign(new Error('unauthorized'), { code: 401 });
    };
    const deps = makeDeps(client);

    const outcome = await updateCalendarEvent(deps, { idempotencyKey: 'key-1', eventId: 'evt-1', fields: { title: 'x' } });

    expect(outcome.kind).toBe('calendar_error');
    expect(outcome.sanitizedErrorCode).toBe('auth_invalid_grant');
  });

  it('returns oauth_not_connected without calling Calendar when resolveCalendarService returns null', async () => {
    const client = new FakeCalendarClient();
    const deps: MutationDeps = { ...makeDeps(client), resolveCalendarService: async () => null };
    const outcome = await updateCalendarEvent(deps, { idempotencyKey: 'key-1', eventId: 'evt-1', fields: { title: 'x' } });
    expect(outcome.kind).toBe('oauth_not_connected');
    expect(client.getEventDetailCallCount).toBe(0);
  });

  it('calls events.patch exactly once even when retried with the same idempotencyKey after success (idempotent replay)', async () => {
    const client = new FakeCalendarClient();
    client.eventStore.set('evt-1', timedDetail());
    const idempotencyRepo = new InMemoryIdempotencyRepository();
    const deps = makeDeps(client, { idempotencyRepo });

    const first = await updateCalendarEvent(deps, { idempotencyKey: 'same-key', eventId: 'evt-1', fields: { title: 'x' } });
    const second = await updateCalendarEvent(deps, { idempotencyKey: 'same-key', eventId: 'evt-1', fields: { title: 'x' } });

    expect(first.kind).toBe('success');
    expect(second.kind).toBe('success');
    expect(second.reusedCompletedResult).toBe(true);
    expect(client.patchCallCount).toBe(1);
  });

  it('returns already_processing (not a second Calendar call) for a concurrent retry while the lease is still held', async () => {
    const client = new FakeCalendarClient();
    client.eventStore.set('evt-1', timedDetail());
    const idempotencyRepo = new InMemoryIdempotencyRepository();
    await idempotencyRepo.acquireLeaseOrGetStatus({
      operationId: 'busy-key',
      actionType: 'update_event',
      calendarId: CALENDAR_ID,
      leaseOwner: 'other-owner',
      leaseDurationMs: 30_000,
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 1000),
    });
    const deps = makeDeps(client, { idempotencyRepo });

    const outcome = await updateCalendarEvent(deps, { idempotencyKey: 'busy-key', eventId: 'evt-1', fields: { title: 'x' } });
    expect(outcome.kind).toBe('already_processing');
    expect(client.patchCallCount).toBe(0);
  });

  it('never logs or returns the event title/location/description in the outcome object', async () => {
    const client = new FakeCalendarClient();
    client.eventStore.set('evt-1', timedDetail({ location: 'UNIQUE_LOCATION_SENTINEL' }));
    const deps = makeDeps(client);
    const outcome = await updateCalendarEvent(deps, { idempotencyKey: 'key-1', eventId: 'evt-1', fields: { title: 'UNIQUE_TITLE_SENTINEL' } });
    expect(JSON.stringify(outcome)).not.toContain('UNIQUE_TITLE_SENTINEL');
    expect(JSON.stringify(outcome)).not.toContain('UNIQUE_LOCATION_SENTINEL');
  });
});

describe('deleteCalendarEvent', () => {
  it('deletes an existing event and marks the idempotency record completed', async () => {
    const client = new FakeCalendarClient();
    client.eventStore.set('evt-1', timedDetail());
    const deps = makeDeps(client);

    const outcome = await deleteCalendarEvent(deps, { idempotencyKey: 'key-1', eventId: 'evt-1' });

    expect(outcome.kind).toBe('success');
    expect(client.deleteCallCount).toBe(1);
    expect(client.eventStore.has('evt-1')).toBe(false);
  });

  it('treats deleting an already-deleted (404) event as success, not an error', async () => {
    const client = new FakeCalendarClient();
    // eventStoreに存在しない = FakeCalendarClient.deleteEventは404を投げる
    const deps = makeDeps(client);

    const outcome = await deleteCalendarEvent(deps, { idempotencyKey: 'key-1', eventId: 'already-gone' });

    expect(outcome.kind).toBe('success');
    expect(outcome.sanitizedErrorCode).toBeNull();
  });

  it('returns calendar_error (not success) for a non-404/410 Calendar failure', async () => {
    const client = new FakeCalendarClient();
    client.eventStore.set('evt-1', timedDetail());
    client.nextDeleteEventError = () => {
      throw Object.assign(new Error('server error'), { code: 500 });
    };
    const deps = makeDeps(client);

    const outcome = await deleteCalendarEvent(deps, { idempotencyKey: 'key-1', eventId: 'evt-1' });
    expect(outcome.kind).toBe('calendar_error');
  });

  it('calls events.delete exactly once even when retried with the same idempotencyKey after success (idempotent replay)', async () => {
    const client = new FakeCalendarClient();
    client.eventStore.set('evt-1', timedDetail());
    const idempotencyRepo = new InMemoryIdempotencyRepository();
    const deps = makeDeps(client, { idempotencyRepo });

    const first = await deleteCalendarEvent(deps, { idempotencyKey: 'same-key', eventId: 'evt-1' });
    const second = await deleteCalendarEvent(deps, { idempotencyKey: 'same-key', eventId: 'evt-1' });

    expect(first.kind).toBe('success');
    expect(second.kind).toBe('success');
    expect(second.reusedCompletedResult).toBe(true);
    expect(client.deleteCallCount).toBe(1);
  });

  it('returns already_processing (not a second Calendar call) for a concurrent retry while the lease is still held', async () => {
    const client = new FakeCalendarClient();
    client.eventStore.set('evt-1', timedDetail());
    const idempotencyRepo = new InMemoryIdempotencyRepository();
    await idempotencyRepo.acquireLeaseOrGetStatus({
      operationId: 'busy-key',
      actionType: 'delete_event',
      calendarId: CALENDAR_ID,
      leaseOwner: 'other-owner',
      leaseDurationMs: 30_000,
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 1000),
    });
    const deps = makeDeps(client, { idempotencyRepo });

    const outcome = await deleteCalendarEvent(deps, { idempotencyKey: 'busy-key', eventId: 'evt-1' });
    expect(outcome.kind).toBe('already_processing');
    expect(client.deleteCallCount).toBe(0);
  });

  it('returns oauth_not_connected without calling Calendar when resolveCalendarService returns null', async () => {
    const client = new FakeCalendarClient();
    const deps: MutationDeps = { ...makeDeps(client), resolveCalendarService: async () => null };
    const outcome = await deleteCalendarEvent(deps, { idempotencyKey: 'key-1', eventId: 'evt-1' });
    expect(outcome.kind).toBe('oauth_not_connected');
    expect(client.deleteCallCount).toBe(0);
  });
});
