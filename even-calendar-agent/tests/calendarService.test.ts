import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { FakeCalendarClient, type CalendarEventDetail } from '../src/calendar/calendarClient.js';
import { createCalendarService } from '../src/calendar/calendarService.js';

const START = DateTime.fromISO('2026-07-23T00:00:00', { zone: 'Asia/Tokyo' });
const END = START.plus({ days: 1 });

function detail(summary: string): CalendarEventDetail {
  return { eventId: 'event-id', summary, status: 'confirmed', startDateTime: '2026-07-23T10:00:00+09:00', startDate: null, endDateTime: '2026-07-23T11:00:00+09:00', endDate: null };
}

describe('CalendarService.listEventsDetailedForDayRange', () => {
  it('returns events and truncated:false when a single page with no nextPageToken is returned', async () => {
    const client = new FakeCalendarClient();
    client.listEventsDetailedPages = [{ events: [detail('a'), detail('b')], nextPageToken: null }];
    const service = createCalendarService(client);
    const result = await service.listEventsDetailedForDayRange({ calendarId: 'primary', start: START, end: END });
    expect(result.events).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(client.listEventsDetailedCallCount).toBe(1);
  });

  it('stops at 50 total and marks truncated:true when the first page already returns 50 with a nextPageToken', async () => {
    const client = new FakeCalendarClient();
    const fifty = Array.from({ length: 50 }, (_, i) => detail(`event-${i}`));
    client.listEventsDetailedPages = [{ events: fifty, nextPageToken: 'more' }];
    const service = createCalendarService(client);
    const result = await service.listEventsDetailedForDayRange({ calendarId: 'primary', start: START, end: END });
    expect(result.events).toHaveLength(50);
    expect(result.truncated).toBe(true);
    // 50件に達した時点で追加ページは取得しない
    expect(client.listEventsDetailedCallCount).toBe(1);
  });

  it('follows pageToken across pages when under 50 and a nextPageToken is still present', async () => {
    const client = new FakeCalendarClient();
    client.listEventsDetailedPages = [
      { events: [detail('a')], nextPageToken: 'page2' },
      { events: [detail('b')], nextPageToken: null },
    ];
    const service = createCalendarService(client);
    const result = await service.listEventsDetailedForDayRange({ calendarId: 'primary', start: START, end: END });
    expect(result.events).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(client.listEventsDetailedCallCount).toBe(2);
    expect(client.listEventsDetailedPageTokensSeen).toEqual([undefined, 'page2']);
  });

  it('returns empty events and truncated:false when there are no events', async () => {
    const client = new FakeCalendarClient();
    client.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    const service = createCalendarService(client);
    const result = await service.listEventsDetailedForDayRange({ calendarId: 'primary', start: START, end: END });
    expect(result.events).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('propagates errors from the underlying client without swallowing them', async () => {
    const client = new FakeCalendarClient();
    client.nextListEventsDetailedError = () => {
      throw new Error('boom');
    };
    const service = createCalendarService(client);
    await expect(service.listEventsDetailedForDayRange({ calendarId: 'primary', start: START, end: END })).rejects.toThrow('boom');
  });
});

describe('CalendarService.listUpcomingEvents', () => {
  // 2026-07-23 12:00:00 Asia/Tokyo
  const NOW = DateTime.fromISO('2026-07-23T12:00:00', { zone: 'Asia/Tokyo' });

  function timed(summary: string, startIso: string, endIso: string): CalendarEventDetail {
    return { eventId: 'event-id', summary, status: 'confirmed', startDateTime: startIso, startDate: null, endDateTime: endIso, endDate: null };
  }

  function allDay(summary: string, startDate: string, endDateExclusive: string): CalendarEventDetail {
    return { eventId: 'event-id', summary, status: 'confirmed', startDateTime: null, startDate, endDateTime: null, endDate: endDateExclusive };
  }

  it('includes a future timed event (start > now)', async () => {
    const client = new FakeCalendarClient();
    client.listEventsDetailedPages = [{ events: [timed('future', '2026-07-23T14:00:00+09:00', '2026-07-23T15:00:00+09:00')], nextPageToken: null }];
    const service = createCalendarService(client);
    const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
    expect(result.events).toHaveLength(1);
  });

  it('excludes an event whose start exactly equals now', async () => {
    const client = new FakeCalendarClient();
    client.listEventsDetailedPages = [{ events: [timed('exact', '2026-07-23T12:00:00+09:00', '2026-07-23T13:00:00+09:00')], nextPageToken: null }];
    const service = createCalendarService(client);
    const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
    expect(result.events).toHaveLength(0);
  });

  it('excludes an ongoing event whose start is before now (even if Google returns it due to timeMin semantics)', async () => {
    const client = new FakeCalendarClient();
    client.listEventsDetailedPages = [{ events: [timed('ongoing', '2026-07-23T11:00:00+09:00', '2026-07-23T13:00:00+09:00')], nextPageToken: null }];
    const service = createCalendarService(client);
    const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
    expect(result.events).toHaveLength(0);
  });

  it('excludes an already-finished past event', async () => {
    const client = new FakeCalendarClient();
    client.listEventsDetailedPages = [{ events: [timed('past', '2026-07-23T08:00:00+09:00', '2026-07-23T09:00:00+09:00')], nextPageToken: null }];
    const service = createCalendarService(client);
    const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
    expect(result.events).toHaveLength(0);
  });

  it('excludes an all-day event starting today (00:00 today is always <= now during that day)', async () => {
    const client = new FakeCalendarClient();
    client.listEventsDetailedPages = [{ events: [allDay('today-allday', '2026-07-23', '2026-07-24')], nextPageToken: null }];
    const service = createCalendarService(client);
    const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
    expect(result.events).toHaveLength(0);
  });

  it('includes an all-day event starting tomorrow or later', async () => {
    const client = new FakeCalendarClient();
    client.listEventsDetailedPages = [{ events: [allDay('tomorrow-allday', '2026-07-24', '2026-07-25')], nextPageToken: null }];
    const service = createCalendarService(client);
    const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
    expect(result.events).toHaveLength(1);
  });

  it('excludes a multi-day all-day event that started in the past', async () => {
    const client = new FakeCalendarClient();
    client.listEventsDetailedPages = [{ events: [allDay('past-multiday', '2026-07-20', '2026-07-26')], nextPageToken: null }];
    const service = createCalendarService(client);
    const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
    expect(result.events).toHaveLength(0);
  });

  it('excludes an event with neither startDateTime nor startDate (invalid/unresolvable start)', async () => {
    const client = new FakeCalendarClient();
    const broken: CalendarEventDetail = { eventId: 'event-id', summary: 'broken', status: 'confirmed', startDateTime: null, startDate: null, endDateTime: null, endDate: null };
    client.listEventsDetailedPages = [{ events: [broken], nextPageToken: null }];
    const service = createCalendarService(client);
    const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
    expect(result.events).toHaveLength(0);
  });

  it('crosses today/tomorrow/future days and preserves chronological (startTime) order', async () => {
    const client = new FakeCalendarClient();
    client.listEventsDetailedPages = [
      {
        events: [
          timed('todayLater', '2026-07-23T14:00:00+09:00', '2026-07-23T15:00:00+09:00'),
          allDay('tomorrowAllDay', '2026-07-24', '2026-07-25'),
          timed('dayAfter', '2026-07-25T09:00:00+09:00', '2026-07-25T10:00:00+09:00'),
        ],
        nextPageToken: null,
      },
    ];
    const service = createCalendarService(client);
    const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
    expect(result.events.map((e) => e.summary)).toEqual(['todayLater', 'tomorrowAllDay', 'dayAfter']);
  });

  it('caps at the requested limit (max 5) even when more future events exist on the same page', async () => {
    const client = new FakeCalendarClient();
    const events = Array.from({ length: 8 }, (_, i) =>
      timed(`e${i}`, `2026-07-23T${14 + i}:00:00+09:00`, `2026-07-23T${15 + i}:00:00+09:00`),
    );
    client.listEventsDetailedPages = [{ events, nextPageToken: null }];
    const service = createCalendarService(client);
    const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
    expect(result.events).toHaveLength(5);
    expect(result.truncated).toBe(true); // 同一ページ内にまだ未消費の未来予定が残っている
  });

  it('returns truncated:false when fewer than limit future events exist across all pages', async () => {
    const client = new FakeCalendarClient();
    client.listEventsDetailedPages = [{ events: [timed('only', '2026-07-23T14:00:00+09:00', '2026-07-23T15:00:00+09:00')], nextPageToken: null }];
    const service = createCalendarService(client);
    const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
    expect(result.events).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });

  it('paginates via pageToken, filtering out past/ongoing events across pages until the limit is reached', async () => {
    const client = new FakeCalendarClient();
    client.listEventsDetailedPages = [
      { events: [timed('ongoing', '2026-07-23T11:00:00+09:00', '2026-07-23T13:00:00+09:00')], nextPageToken: 'page2' },
      { events: [timed('future1', '2026-07-23T14:00:00+09:00', '2026-07-23T15:00:00+09:00')], nextPageToken: null },
    ];
    const service = createCalendarService(client);
    const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
    expect(result.events.map((e) => e.summary)).toEqual(['future1']);
    expect(result.truncated).toBe(false);
    expect(client.listEventsDetailedCallCount).toBe(2);
  });

  it('marks truncated:true when the limit is reached exactly at the end of a page and a nextPageToken remains', async () => {
    const client = new FakeCalendarClient();
    const fiveEvents = Array.from({ length: 5 }, (_, i) =>
      timed(`e${i}`, `2026-07-23T${14 + i}:00:00+09:00`, `2026-07-23T${15 + i}:00:00+09:00`),
    );
    client.listEventsDetailedPages = [{ events: fiveEvents, nextPageToken: 'more' }];
    const service = createCalendarService(client);
    const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
    expect(result.events).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it('marks truncated:false when the limit is reached exactly at the end of the final page (no nextPageToken)', async () => {
    const client = new FakeCalendarClient();
    const fiveEvents = Array.from({ length: 5 }, (_, i) =>
      timed(`e${i}`, `2026-07-23T${14 + i}:00:00+09:00`, `2026-07-23T${15 + i}:00:00+09:00`),
    );
    client.listEventsDetailedPages = [{ events: fiveEvents, nextPageToken: null }];
    const service = createCalendarService(client);
    const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
    expect(result.events).toHaveLength(5);
    expect(result.truncated).toBe(false);
  });

  it('respects a limit lower than 5', async () => {
    const client = new FakeCalendarClient();
    const events = Array.from({ length: 3 }, (_, i) => timed(`e${i}`, `2026-07-23T${14 + i}:00:00+09:00`, `2026-07-23T${15 + i}:00:00+09:00`));
    client.listEventsDetailedPages = [{ events, nextPageToken: null }];
    const service = createCalendarService(client);
    const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 2 });
    expect(result.events).toHaveLength(2);
  });

  it('returns empty events and truncated:false when there are no future events at all', async () => {
    const client = new FakeCalendarClient();
    client.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
    const service = createCalendarService(client);
    const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
    expect(result.events).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('stops after a defensive maximum number of pages even if pageToken never ends', async () => {
    const client = new FakeCalendarClient();
    // すべて過去/進行中のイベントのみを返し続け、5件に到達しないまま無限にpageTokenを返すケースを模倣する
    const neverEnoughPage = { events: [timed('ongoing', '2026-07-23T11:00:00+09:00', '2026-07-23T13:00:00+09:00')], nextPageToken: 'more' };
    client.listEventsDetailedPages = [neverEnoughPage, neverEnoughPage, neverEnoughPage, neverEnoughPage, neverEnoughPage, neverEnoughPage];
    const service = createCalendarService(client);
    const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
    expect(result.events).toHaveLength(0);
    expect(result.truncated).toBe(true);
    expect(client.listEventsDetailedCallCount).toBeLessThanOrEqual(5);
  });

  it('does not call Calendar insert/update/delete', async () => {
    const client = new FakeCalendarClient();
    client.listEventsDetailedPages = [{ events: [timed('future', '2026-07-23T14:00:00+09:00', '2026-07-23T15:00:00+09:00')], nextPageToken: null }];
    const service = createCalendarService(client);
    await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
    expect(client.insertCallCount).toBe(0);
  });

  it('propagates errors from the underlying client without swallowing them', async () => {
    const client = new FakeCalendarClient();
    client.nextListEventsDetailedError = () => {
      throw new Error('boom');
    };
    const service = createCalendarService(client);
    await expect(service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 })).rejects.toThrow('boom');
  });

  describe('2-month window (Phase 2G fix: calendar months, not a fixed 60-day window)', () => {
    it('passes windowStart=now and windowEnd=now+2 calendar months as timeMin/timeMax to the Calendar API', async () => {
      const client = new FakeCalendarClient();
      client.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
      const service = createCalendarService(client);
      await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
      expect(client.listEventsDetailedParamsSeen[0]?.timeMinIso).toBe('2026-07-23T12:00:00+09:00');
      expect(client.listEventsDetailedParamsSeen[0]?.timeMaxIso).toBe('2026-09-23T12:00:00+09:00');
    });

    it('uses calendar-month arithmetic across a 31-day month, not a fixed 60-day window', async () => {
      // 2026-07-31 12:00 JST + 2 calendar months = 2026-09-30 12:00 JST (not 2026-09-29, which a fixed 61/62-day window might produce)
      const client = new FakeCalendarClient();
      client.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
      const service = createCalendarService(client);
      const july31 = DateTime.fromISO('2026-07-31T12:00:00', { zone: 'Asia/Tokyo' });
      await service.listUpcomingEvents({ calendarId: 'primary', now: july31, limit: 5 });
      expect(client.listEventsDetailedParamsSeen[0]?.timeMaxIso).toBe('2026-09-30T12:00:00+09:00');
    });

    it('rolls the window end over a year boundary correctly', async () => {
      const client = new FakeCalendarClient();
      client.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
      const service = createCalendarService(client);
      const nov30 = DateTime.fromISO('2026-11-30T09:00:00', { zone: 'Asia/Tokyo' });
      await service.listUpcomingEvents({ calendarId: 'primary', now: nov30, limit: 5 });
      expect(client.listEventsDetailedParamsSeen[0]?.timeMaxIso).toBe('2027-01-30T09:00:00+09:00');
    });

    it('handles a leap-day start correctly (2028 is a leap year)', async () => {
      const client = new FakeCalendarClient();
      client.listEventsDetailedPages = [{ events: [], nextPageToken: null }];
      const service = createCalendarService(client);
      const leapDay = DateTime.fromISO('2028-02-29T10:00:00', { zone: 'Asia/Tokyo' });
      await service.listUpcomingEvents({ calendarId: 'primary', now: leapDay, limit: 5 });
      expect(client.listEventsDetailedParamsSeen[0]?.timeMaxIso).toBe('2028-04-29T10:00:00+09:00');
    });

    it('includes an event next month, within the 2-month window', async () => {
      const client = new FakeCalendarClient();
      client.listEventsDetailedPages = [{ events: [timed('nextMonth', '2026-08-15T10:00:00+09:00', '2026-08-15T11:00:00+09:00')], nextPageToken: null }];
      const service = createCalendarService(client);
      const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
      expect(result.events).toHaveLength(1);
    });

    it('includes an event in the second month, still within the 2-month window', async () => {
      const client = new FakeCalendarClient();
      client.listEventsDetailedPages = [{ events: [timed('twoMonthsOut', '2026-09-20T10:00:00+09:00', '2026-09-20T11:00:00+09:00')], nextPageToken: null }];
      const service = createCalendarService(client);
      const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
      expect(result.events).toHaveLength(1);
    });

    it('excludes an event whose start exactly equals windowEnd', async () => {
      const client = new FakeCalendarClient();
      client.listEventsDetailedPages = [{ events: [timed('exactWindowEnd', '2026-09-23T12:00:00+09:00', '2026-09-23T13:00:00+09:00')], nextPageToken: null }];
      const service = createCalendarService(client);
      const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
      expect(result.events).toHaveLength(0);
    });

    it('excludes an event starting after windowEnd (more than 2 months out)', async () => {
      const client = new FakeCalendarClient();
      client.listEventsDetailedPages = [{ events: [timed('tooFar', '2026-09-24T10:00:00+09:00', '2026-09-24T11:00:00+09:00')], nextPageToken: null }];
      const service = createCalendarService(client);
      const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
      expect(result.events).toHaveLength(0);
    });

    it('excludes an all-day event starting after windowEnd (the day after the window-end date, since windowEnd is 2026-09-23T12:00 and the all-day start compares as 00:00 on its date)', async () => {
      const client = new FakeCalendarClient();
      client.listEventsDetailedPages = [{ events: [allDay('allDayAfterWindowEnd', '2026-09-24', '2026-09-25')], nextPageToken: null }];
      const service = createCalendarService(client);
      const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
      expect(result.events).toHaveLength(0);
    });

    it('includes an all-day event starting on the windowEnd date but before the windowEnd time-of-day (00:00 < 12:00)', async () => {
      const client = new FakeCalendarClient();
      client.listEventsDetailedPages = [{ events: [allDay('allDaySameDateAsWindowEnd', '2026-09-23', '2026-09-24')], nextPageToken: null }];
      const service = createCalendarService(client);
      const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
      expect(result.events).toHaveLength(1);
    });

    it('includes an all-day event within the window (next month)', async () => {
      const client = new FakeCalendarClient();
      client.listEventsDetailedPages = [{ events: [allDay('allDayNextMonth', '2026-08-12', '2026-08-13')], nextPageToken: null }];
      const service = createCalendarService(client);
      const result = await service.listUpcomingEvents({ calendarId: 'primary', now: NOW, limit: 5 });
      expect(result.events).toHaveLength(1);
    });
  });
});
