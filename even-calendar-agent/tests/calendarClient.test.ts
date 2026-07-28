import { describe, expect, it, vi } from 'vitest';
import type { calendar_v3 } from 'googleapis';
import { GoogleCalendarClient, isNotFoundError } from '../src/calendar/calendarClient.js';

function fakeCalendar(items: unknown[], nextPageToken?: string): calendar_v3.Calendar {
  const list = vi.fn().mockResolvedValue({ data: { items, ...(nextPageToken ? { nextPageToken } : {}) } });
  return { events: { list } } as unknown as calendar_v3.Calendar;
}

describe('GoogleCalendarClient.listEventsDetailed', () => {
  it('maps timed event fields (summary/status/start/end dateTime)', async () => {
    const calendar = fakeCalendar([
      {
        id: 'raw-google-id-should-not-matter',
        status: 'confirmed',
        summary: '打ち合わせ',
        start: { dateTime: '2026-07-23T15:00:00+09:00' },
        end: { dateTime: '2026-07-23T16:00:00+09:00' },
      },
    ]);
    const client = new GoogleCalendarClient(calendar);
    const result = await client.listEventsDetailed({
      calendarId: 'primary',
      timeMinIso: '2026-07-23T00:00:00+09:00',
      timeMaxIso: '2026-07-24T00:00:00+09:00',
      timeZone: 'Asia/Tokyo',
      maxResults: 50,
    });
    expect(result.events).toEqual([
      {
        eventId: 'raw-google-id-should-not-matter',
        summary: '打ち合わせ',
        status: 'confirmed',
        startDateTime: '2026-07-23T15:00:00+09:00',
        startDate: null,
        endDateTime: '2026-07-23T16:00:00+09:00',
        endDate: null,
      },
    ]);
    expect(result.nextPageToken).toBeNull();
  });

  it('maps all-day event fields (start.date/end.date, no dateTime)', async () => {
    const calendar = fakeCalendar([
      { id: 'all-day-id', status: 'confirmed', summary: '休暇', start: { date: '2026-07-23' }, end: { date: '2026-07-24' } },
    ]);
    const client = new GoogleCalendarClient(calendar);
    const result = await client.listEventsDetailed({
      calendarId: 'primary',
      timeMinIso: '2026-07-23T00:00:00+09:00',
      timeMaxIso: '2026-07-24T00:00:00+09:00',
      timeZone: 'Asia/Tokyo',
      maxResults: 50,
    });
    expect(result.events).toEqual([
      { eventId: 'all-day-id', summary: '休暇', status: 'confirmed', startDateTime: null, startDate: '2026-07-23', endDateTime: null, endDate: '2026-07-24' },
    ]);
  });

  it('excludes cancelled events', async () => {
    const calendar = fakeCalendar([
      { status: 'cancelled', summary: 'キャンセル済み', start: { dateTime: '2026-07-23T10:00:00+09:00' }, end: { dateTime: '2026-07-23T11:00:00+09:00' } },
      { status: 'confirmed', summary: '有効', start: { dateTime: '2026-07-23T12:00:00+09:00' }, end: { dateTime: '2026-07-23T13:00:00+09:00' } },
    ]);
    const client = new GoogleCalendarClient(calendar);
    const result = await client.listEventsDetailed({
      calendarId: 'primary',
      timeMinIso: '2026-07-23T00:00:00+09:00',
      timeMaxIso: '2026-07-24T00:00:00+09:00',
      timeZone: 'Asia/Tokyo',
      maxResults: 50,
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.summary).toBe('有効');
  });

  it('passes through nextPageToken for pagination', async () => {
    const calendar = fakeCalendar([], 'page-2-token');
    const client = new GoogleCalendarClient(calendar);
    const result = await client.listEventsDetailed({
      calendarId: 'primary',
      timeMinIso: '2026-07-23T00:00:00+09:00',
      timeMaxIso: '2026-07-24T00:00:00+09:00',
      timeZone: 'Asia/Tokyo',
      maxResults: 50,
    });
    expect(result.nextPageToken).toBe('page-2-token');
  });

  it('calls events.list with singleEvents/orderBy/showDeleted/maxResults and no insert/update/delete', async () => {
    const list = vi.fn().mockResolvedValue({ data: { items: [] } });
    const calendar = { events: { list, insert: vi.fn(), delete: vi.fn(), update: vi.fn(), patch: vi.fn() } } as unknown as calendar_v3.Calendar;
    const client = new GoogleCalendarClient(calendar);
    await client.listEventsDetailed({
      calendarId: 'primary',
      timeMinIso: '2026-07-23T00:00:00+09:00',
      timeMaxIso: '2026-07-24T00:00:00+09:00',
      timeZone: 'Asia/Tokyo',
      maxResults: 50,
      pageToken: 'abc',
    });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: 'primary',
        singleEvents: true,
        orderBy: 'startTime',
        showDeleted: false,
        maxResults: 50,
        pageToken: 'abc',
      }),
      expect.anything(),
    );
    expect((calendar.events as unknown as { insert: ReturnType<typeof vi.fn> }).insert).not.toHaveBeenCalled();
    expect((calendar.events as unknown as { delete: ReturnType<typeof vi.fn> }).delete).not.toHaveBeenCalled();
    expect((calendar.events as unknown as { update: ReturnType<typeof vi.fn> }).update).not.toHaveBeenCalled();
    expect((calendar.events as unknown as { patch: ReturnType<typeof vi.fn> }).patch).not.toHaveBeenCalled();
  });
});

describe('GoogleCalendarClient.insertEvent', () => {
  function fakeInsertCalendar(): { calendar: calendar_v3.Calendar; insert: ReturnType<typeof vi.fn> } {
    const insert = vi.fn().mockResolvedValue({ data: { id: 'evt-1' } });
    const calendar = { events: { insert } } as unknown as calendar_v3.Calendar;
    return { calendar, insert };
  }

  it('sends {dateTime, timeZone} for a timed event (regression: existing behavior unchanged)', async () => {
    const { calendar, insert } = fakeInsertCalendar();
    const client = new GoogleCalendarClient(calendar);

    await client.insertEvent({
      calendarId: 'primary',
      eventId: 'evt-1',
      summary: '打ち合わせ',
      startDateTime: '2026-07-23T15:00:00+09:00',
      endDateTime: '2026-07-23T16:00:00+09:00',
      timeZone: 'Asia/Tokyo',
      description: 'メモ',
      operationId: 'op-1',
    });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: 'primary',
        requestBody: expect.objectContaining({
          id: 'evt-1',
          start: { dateTime: '2026-07-23T15:00:00+09:00', timeZone: 'Asia/Tokyo' },
          end: { dateTime: '2026-07-23T16:00:00+09:00', timeZone: 'Asia/Tokyo' },
        }),
      }),
    );
  });

  it('sends {date} (no dateTime) for a single-day all-day event, using the exclusive end date as-is', async () => {
    const { calendar, insert } = fakeInsertCalendar();
    const client = new GoogleCalendarClient(calendar);

    await client.insertEvent({
      calendarId: 'primary',
      eventId: 'evt-2',
      summary: '休暇',
      allDay: true,
      startDate: '2026-08-03',
      endDateExclusive: '2026-08-04',
      description: '',
      operationId: 'op-2',
    });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          start: { date: '2026-08-03' },
          end: { date: '2026-08-04' },
        }),
      }),
    );
  });

  it('sends {date} for a multi-day all-day event, passing the exclusive end date through unchanged', async () => {
    const { calendar, insert } = fakeInsertCalendar();
    const client = new GoogleCalendarClient(calendar);

    await client.insertEvent({
      calendarId: 'primary',
      eventId: 'evt-3',
      summary: '旅行',
      allDay: true,
      startDate: '2026-08-03',
      endDateExclusive: '2026-08-06',
      description: '',
      operationId: 'op-3',
    });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          start: { date: '2026-08-03' },
          end: { date: '2026-08-06' },
        }),
      }),
    );
  });
});

describe('isNotFoundError', () => {
  it('treats HTTP 404 as not found', () => {
    expect(isNotFoundError(Object.assign(new Error('x'), { code: 404 }))).toBe(true);
  });
  it('treats HTTP 410 (Gone) as not found', () => {
    expect(isNotFoundError(Object.assign(new Error('x'), { response: { status: 410 } }))).toBe(true);
  });
  it('does not treat other statuses as not found', () => {
    expect(isNotFoundError(Object.assign(new Error('x'), { code: 500 }))).toBe(false);
  });
});

describe('GoogleCalendarClient.getEventDetail', () => {
  function fakeGetCalendar(data: unknown): calendar_v3.Calendar {
    const get = vi.fn().mockResolvedValue({ data });
    return { events: { get } } as unknown as calendar_v3.Calendar;
  }

  it('maps full detail fields including description/location/attendees/conferenceJoinUrl/etag', async () => {
    const calendar = fakeGetCalendar({
      id: 'evt-1',
      status: 'confirmed',
      summary: '打ち合わせ',
      description: 'メモ',
      location: '会議室A',
      start: { dateTime: '2026-07-23T15:00:00+09:00' },
      end: { dateTime: '2026-07-23T16:00:00+09:00' },
      attendees: [{ email: 'a@example.com', displayName: 'A', responseStatus: 'accepted' }],
      conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.example.com/xyz' }] },
      etag: '"abc123"',
    });
    const client = new GoogleCalendarClient(calendar);
    const detail = await client.getEventDetail('primary', 'evt-1');
    expect(detail).toEqual({
      eventId: 'evt-1',
      status: 'confirmed',
      summary: '打ち合わせ',
      description: 'メモ',
      location: '会議室A',
      startDateTime: '2026-07-23T15:00:00+09:00',
      startDate: null,
      endDateTime: '2026-07-23T16:00:00+09:00',
      endDate: null,
      attendees: [{ email: 'a@example.com', displayName: 'A', responseStatus: 'accepted' }],
      conferenceJoinUrl: 'https://meet.example.com/xyz',
      etag: '"abc123"',
    });
  });

  it('returns nulls for absent optional fields (no attendees/conferenceData/etag/description/location)', async () => {
    const calendar = fakeGetCalendar({
      id: 'evt-2',
      status: 'confirmed',
      summary: '予定',
      start: { date: '2026-07-23' },
      end: { date: '2026-07-24' },
    });
    const client = new GoogleCalendarClient(calendar);
    const detail = await client.getEventDetail('primary', 'evt-2');
    expect(detail).toEqual({
      eventId: 'evt-2',
      status: 'confirmed',
      summary: '予定',
      description: null,
      location: null,
      startDateTime: null,
      startDate: '2026-07-23',
      endDateTime: null,
      endDate: '2026-07-24',
      attendees: null,
      conferenceJoinUrl: null,
      etag: null,
    });
  });

  it('returns null for a cancelled event', async () => {
    const calendar = fakeGetCalendar({ id: 'evt-3', status: 'cancelled' });
    const client = new GoogleCalendarClient(calendar);
    expect(await client.getEventDetail('primary', 'evt-3')).toBeNull();
  });

  it('returns null on a 404/410 response instead of throwing', async () => {
    const get = vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }));
    const calendar = { events: { get } } as unknown as calendar_v3.Calendar;
    const client = new GoogleCalendarClient(calendar);
    expect(await client.getEventDetail('primary', 'missing')).toBeNull();
  });

  it('rethrows non-404/410 errors', async () => {
    const get = vi.fn().mockRejectedValue(Object.assign(new Error('server error'), { code: 500 }));
    const calendar = { events: { get } } as unknown as calendar_v3.Calendar;
    const client = new GoogleCalendarClient(calendar);
    await expect(client.getEventDetail('primary', 'evt-1')).rejects.toThrow('server error');
  });
});

describe('GoogleCalendarClient.patchEvent', () => {
  it('sends the If-Match header with the provided etag and only the specified requestBody fields', async () => {
    const patch = vi.fn().mockResolvedValue({ data: { id: 'evt-1', etag: '"new-etag"' } });
    const calendar = { events: { patch } } as unknown as calendar_v3.Calendar;
    const client = new GoogleCalendarClient(calendar);

    const result = await client.patchEvent({ calendarId: 'primary', eventId: 'evt-1', ifMatchEtag: '"old-etag"', summary: '新タイトル' });

    expect(result).toEqual({ eventId: 'evt-1', etag: '"new-etag"' });
    expect(patch).toHaveBeenCalledWith(
      { calendarId: 'primary', eventId: 'evt-1', requestBody: { summary: '新タイトル' } },
      expect.objectContaining({ headers: { 'If-Match': '"old-etag"' } }),
    );
  });

  it('propagates a 412 conflict from the underlying API', async () => {
    const patch = vi.fn().mockRejectedValue(Object.assign(new Error('conflict'), { code: 412 }));
    const calendar = { events: { patch } } as unknown as calendar_v3.Calendar;
    const client = new GoogleCalendarClient(calendar);
    await expect(client.patchEvent({ calendarId: 'primary', eventId: 'evt-1', ifMatchEtag: '"old-etag"', summary: 'x' })).rejects.toMatchObject({
      code: 412,
    });
  });
});

describe('GoogleCalendarClient.deleteEvent', () => {
  it('calls events.delete with calendarId/eventId', async () => {
    const del = vi.fn().mockResolvedValue({ data: undefined });
    const calendar = { events: { delete: del } } as unknown as calendar_v3.Calendar;
    const client = new GoogleCalendarClient(calendar);
    await client.deleteEvent('primary', 'evt-1');
    expect(del).toHaveBeenCalledWith({ calendarId: 'primary', eventId: 'evt-1' }, expect.anything());
  });

  it('propagates a 404 from the underlying API (caller decides idempotent handling)', async () => {
    const del = vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }));
    const calendar = { events: { delete: del } } as unknown as calendar_v3.Calendar;
    const client = new GoogleCalendarClient(calendar);
    await expect(client.deleteEvent('primary', 'evt-1')).rejects.toMatchObject({ code: 404 });
  });
});
