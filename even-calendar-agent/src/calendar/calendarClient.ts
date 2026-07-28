import type { calendar_v3 } from 'googleapis';

interface CalendarEventInputCommon {
  calendarId: string;
  eventId: string;
  summary: string;
  description: string;
  operationId: string;
}

/**
 * 通常予定(timed)と終日予定(all-day)を判別可能ユニオンで表す。allDay省略時はfalse相当として
 * 通常予定を意味する(既存呼び出し元との後方互換のため、allDayフィールド自体を省略できる)。
 * 終日側のstartDate/endDateExclusiveはGoogle Calendar API方式の排他的終了日をそのまま渡す
 * (この層では±1日変換を一切行わない)。
 */
export type CalendarEventInput =
  | (CalendarEventInputCommon & { allDay?: false; startDateTime: string; endDateTime: string; timeZone: string })
  | (CalendarEventInputCommon & { allDay: true; startDate: string; endDateExclusive: string });

export interface CalendarEventSummary {
  eventId: string;
  summary: string | null;
  startDateTime: string | null;
  startDate: string | null;
  status: string;
}

export interface ListEventsParams {
  calendarId: string;
  timeMinIso: string;
  timeMaxIso: string;
  maxResults: number;
}

/**
 * G2プラグインの日次/近日予定一覧・詳細取得共通の一覧用イベント形。eventIdはevents/{id}への
 * detail/update/delete要求に使う実際のGoogle event ID(呼び出し側での保持は必須。ただし
 * description・location・attendees等の内容フィールドはここには一切含まない)。
 */
export interface CalendarEventDetail {
  eventId: string;
  summary: string | null;
  status: string;
  startDateTime: string | null;
  startDate: string | null;
  endDateTime: string | null;
  endDate: string | null;
}

export interface EventAttendeeDetail {
  email: string;
  displayName: string | null;
  responseStatus: string | null;
}

/** /plugin/calendar-events/:eventId (GET) 専用の1件詳細形。空/未設定のフィールドはnullを返し、省略はレスポンス層(eventResponseMapping)の責務。 */
export interface CalendarEventFullDetail {
  eventId: string;
  status: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  startDateTime: string | null;
  startDate: string | null;
  endDateTime: string | null;
  endDate: string | null;
  attendees: EventAttendeeDetail[] | null;
  conferenceJoinUrl: string | null;
  etag: string | null;
}

export type EventTimingField = { dateTime: string; timeZone: string } | { date: string };

export interface PatchEventInput {
  calendarId: string;
  eventId: string;
  /** 直前のGET時点のetag。events.patchへIf-Matchとして渡し、他デバイスからの同時編集をHTTP 412として検出する。 */
  ifMatchEtag: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: EventTimingField;
  end?: EventTimingField;
  abortSignal?: AbortSignal;
}

export interface PatchEventResult {
  eventId: string;
  etag: string | null;
}

export interface ListEventsDetailedParams {
  calendarId: string;
  timeMinIso: string;
  /** 省略時はGoogle Calendar API側で無期限(未来方向へ制限なし)として扱われる(upcoming用)。 */
  timeMaxIso?: string;
  timeZone: string;
  maxResults: number;
  pageToken?: string;
  abortSignal?: AbortSignal;
}

export interface ListEventsDetailedResult {
  events: CalendarEventDetail[];
  nextPageToken: string | null;
}

export interface CalendarClient {
  listEvents(params: ListEventsParams): Promise<CalendarEventSummary[]>;
  listEventsDetailed(params: ListEventsDetailedParams): Promise<ListEventsDetailedResult>;
  insertEvent(input: CalendarEventInput): Promise<{ eventId: string }>;
  getEvent(calendarId: string, eventId: string): Promise<{ eventId: string } | null>;
  getEventDetail(calendarId: string, eventId: string, abortSignal?: AbortSignal): Promise<CalendarEventFullDetail | null>;
  patchEvent(input: PatchEventInput): Promise<PatchEventResult>;
  deleteEvent(calendarId: string, eventId: string, abortSignal?: AbortSignal): Promise<void>;
}

function hasHttpStatus(err: unknown, status: number): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const record = err as Record<string, unknown>;
  if (record.code === status) {
    return true;
  }
  const response = record.response as Record<string, unknown> | undefined;
  return typeof response === 'object' && response !== null && response.status === status;
}

/** 404(Not Found)・410(Gone、削除済みイベントの再取得/再削除時にGoogleが返す)の両方を「対象が存在しない」として扱う。 */
export function isNotFoundError(err: unknown): boolean {
  return hasHttpStatus(err, 404) || hasHttpStatus(err, 410);
}

const MAX_ATTENDEES = 20;

function mapAttendees(raw: calendar_v3.Schema$EventAttendee[] | undefined): EventAttendeeDetail[] | null {
  if (!raw || raw.length === 0) {
    return null;
  }
  const mapped = raw
    .filter((a): a is calendar_v3.Schema$EventAttendee & { email: string } => typeof a.email === 'string')
    .slice(0, MAX_ATTENDEES)
    .map((a) => ({ email: a.email, displayName: a.displayName ?? null, responseStatus: a.responseStatus ?? null }));
  return mapped.length > 0 ? mapped : null;
}

function mapConferenceJoinUrl(conferenceData: calendar_v3.Schema$ConferenceData | undefined): string | null {
  const videoEntryPoint = conferenceData?.entryPoints?.find((ep) => ep.entryPointType === 'video');
  return videoEntryPoint?.uri ?? null;
}

/**
 * insertEvent用のstart/endを組み立てる。終日(allDay:true)は{date}形式(dateTimeは使わない)、
 * 通常予定は既存どおり{dateTime, timeZone}形式。patchEvent/mergeTiming/resolveEditInstructionと
 * 同じEventTimingFieldの形へ寄せることで、読み取り側・更新側との表現の不一致を防ぐ。
 */
function buildInsertTiming(input: CalendarEventInput): { start: EventTimingField; end: EventTimingField } {
  if (input.allDay === true) {
    return { start: { date: input.startDate }, end: { date: input.endDateExclusive } };
  }
  return {
    start: { dateTime: input.startDateTime, timeZone: input.timeZone },
    end: { dateTime: input.endDateTime, timeZone: input.timeZone },
  };
}

/** 本番用のGoogle Calendar APIクライアント。実際のGoogle APIを呼び出す。 */
export class GoogleCalendarClient implements CalendarClient {
  constructor(private readonly calendar: calendar_v3.Calendar) {}

  async listEvents(params: ListEventsParams): Promise<CalendarEventSummary[]> {
    const res = await this.calendar.events.list({
      calendarId: params.calendarId,
      singleEvents: true,
      orderBy: 'startTime',
      timeMin: params.timeMinIso,
      timeMax: params.timeMaxIso,
      maxResults: params.maxResults,
      showDeleted: false,
    });

    const items = res.data.items ?? [];
    return items
      .filter((item) => item.status !== 'cancelled')
      .map((item) => ({
        eventId: item.id ?? '',
        summary: item.summary ?? null,
        startDateTime: item.start?.dateTime ?? null,
        startDate: item.start?.date ?? null,
        status: item.status ?? 'confirmed',
      }));
  }

  async listEventsDetailed(params: ListEventsDetailedParams): Promise<ListEventsDetailedResult> {
    const res = await this.calendar.events.list(
      {
        calendarId: params.calendarId,
        singleEvents: true,
        orderBy: 'startTime',
        timeMin: params.timeMinIso,
        timeZone: params.timeZone,
        maxResults: params.maxResults,
        showDeleted: false,
        ...(params.timeMaxIso !== undefined ? { timeMax: params.timeMaxIso } : {}),
        ...(params.pageToken !== undefined ? { pageToken: params.pageToken } : {}),
      },
      { ...(params.abortSignal !== undefined ? { signal: params.abortSignal } : {}) },
    );

    const items = res.data.items ?? [];
    const events = items
      .filter((item) => item.status !== 'cancelled')
      .map((item) => ({
        eventId: item.id ?? '',
        summary: item.summary ?? null,
        status: item.status ?? 'confirmed',
        startDateTime: item.start?.dateTime ?? null,
        startDate: item.start?.date ?? null,
        endDateTime: item.end?.dateTime ?? null,
        endDate: item.end?.date ?? null,
      }));

    return { events, nextPageToken: res.data.nextPageToken ?? null };
  }

  async insertEvent(input: CalendarEventInput): Promise<{ eventId: string }> {
    const { start, end } = buildInsertTiming(input);

    const res = await this.calendar.events.insert({
      calendarId: input.calendarId,
      sendUpdates: 'none',
      requestBody: {
        id: input.eventId,
        summary: input.summary,
        description: input.description,
        start,
        end,
        extendedProperties: {
          private: {
            source: 'even-calendar-agent',
            operationId: input.operationId,
          },
        },
      },
    });

    return { eventId: res.data.id ?? input.eventId };
  }

  async getEvent(calendarId: string, eventId: string): Promise<{ eventId: string } | null> {
    try {
      const res = await this.calendar.events.get({ calendarId, eventId });
      if (res.data.status === 'cancelled') {
        return null;
      }
      return { eventId: res.data.id ?? eventId };
    } catch (err) {
      if (isNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  }

  async getEventDetail(calendarId: string, eventId: string, abortSignal?: AbortSignal): Promise<CalendarEventFullDetail | null> {
    try {
      const res = await this.calendar.events.get({ calendarId, eventId }, { ...(abortSignal !== undefined ? { signal: abortSignal } : {}) });
      if (res.data.status === 'cancelled') {
        return null;
      }
      return {
        eventId: res.data.id ?? eventId,
        status: res.data.status ?? 'confirmed',
        summary: res.data.summary ?? null,
        description: res.data.description ?? null,
        location: res.data.location ?? null,
        startDateTime: res.data.start?.dateTime ?? null,
        startDate: res.data.start?.date ?? null,
        endDateTime: res.data.end?.dateTime ?? null,
        endDate: res.data.end?.date ?? null,
        attendees: mapAttendees(res.data.attendees ?? undefined),
        conferenceJoinUrl: mapConferenceJoinUrl(res.data.conferenceData ?? undefined),
        etag: res.data.etag ?? null,
      };
    } catch (err) {
      if (isNotFoundError(err)) {
        return null;
      }
      throw err;
    }
  }

  async patchEvent(input: PatchEventInput): Promise<PatchEventResult> {
    const res = await this.calendar.events.patch(
      {
        calendarId: input.calendarId,
        eventId: input.eventId,
        requestBody: {
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.location !== undefined ? { location: input.location } : {}),
          ...(input.start !== undefined ? { start: input.start } : {}),
          ...(input.end !== undefined ? { end: input.end } : {}),
        },
      },
      { headers: { 'If-Match': input.ifMatchEtag }, ...(input.abortSignal !== undefined ? { signal: input.abortSignal } : {}) },
    );
    return { eventId: res.data.id ?? input.eventId, etag: res.data.etag ?? null };
  }

  async deleteEvent(calendarId: string, eventId: string, abortSignal?: AbortSignal): Promise<void> {
    await this.calendar.events.delete({ calendarId, eventId }, { ...(abortSignal !== undefined ? { signal: abortSignal } : {}) });
  }
}

/**
 * テスト・ローカル疎通確認用のFake実装。実Google Calendar APIへは一切アクセスしない。
 * insertEventは同一eventIdの再挿入時、Google側の実際の挙動(409)を模倣する。
 */
export class FakeCalendarClient implements CalendarClient {
  public listEventsResult: CalendarEventSummary[] = [];
  public listCallCount = 0;
  public insertCallCount = 0;
  public nextInsertError: (() => never) | null = null;
  private readonly insertedEvents = new Map<string, CalendarEventInput>();

  /** listEventsDetailedの複数ページを順に返す(未設定/不足分は空・nextPageToken:nullとして扱う)。 */
  public listEventsDetailedPages: ListEventsDetailedResult[] = [];
  public listEventsDetailedCallCount = 0;
  public listEventsDetailedPageTokensSeen: (string | undefined)[] = [];
  public listEventsDetailedParamsSeen: ListEventsDetailedParams[] = [];
  public nextListEventsDetailedError: (() => never) | null = null;

  async listEvents(_params: ListEventsParams): Promise<CalendarEventSummary[]> {
    this.listCallCount += 1;
    return this.listEventsResult;
  }

  async listEventsDetailed(params: ListEventsDetailedParams): Promise<ListEventsDetailedResult> {
    this.listEventsDetailedPageTokensSeen.push(params.pageToken);
    this.listEventsDetailedParamsSeen.push(params);
    const pageIndex = this.listEventsDetailedCallCount;
    this.listEventsDetailedCallCount += 1;

    if (this.nextListEventsDetailedError) {
      const throwFn = this.nextListEventsDetailedError;
      this.nextListEventsDetailedError = null;
      throwFn();
    }

    return this.listEventsDetailedPages[pageIndex] ?? { events: [], nextPageToken: null };
  }

  async insertEvent(input: CalendarEventInput): Promise<{ eventId: string }> {
    this.insertCallCount += 1;

    if (this.insertedEvents.has(input.eventId)) {
      const err = new Error('duplicate event id') as Error & { code: number };
      err.code = 409;
      throw err;
    }

    if (this.nextInsertError) {
      const throwFn = this.nextInsertError;
      this.nextInsertError = null;
      throwFn();
    }

    this.insertedEvents.set(input.eventId, input);
    return { eventId: input.eventId };
  }

  async getEvent(_calendarId: string, eventId: string): Promise<{ eventId: string } | null> {
    return this.insertedEvents.has(eventId) ? { eventId } : null;
  }

  /** detail/update/delete系テスト用のイベントストア。テストは直接この場に既存イベントをseedする。 */
  public eventStore = new Map<string, CalendarEventFullDetail>();
  public getEventDetailCallCount = 0;
  public nextGetEventDetailError: (() => never) | null = null;
  public patchCallCount = 0;
  public patchEventParamsSeen: PatchEventInput[] = [];
  public nextPatchEventError: (() => never) | null = null;
  public deleteCallCount = 0;
  public nextDeleteEventError: (() => never) | null = null;

  async getEventDetail(_calendarId: string, eventId: string): Promise<CalendarEventFullDetail | null> {
    this.getEventDetailCallCount += 1;
    if (this.nextGetEventDetailError) {
      const throwFn = this.nextGetEventDetailError;
      this.nextGetEventDetailError = null;
      throwFn();
    }
    return this.eventStore.get(eventId) ?? null;
  }

  async patchEvent(input: PatchEventInput): Promise<PatchEventResult> {
    this.patchCallCount += 1;
    this.patchEventParamsSeen.push(input);

    if (this.nextPatchEventError) {
      const throwFn = this.nextPatchEventError;
      this.nextPatchEventError = null;
      throwFn();
    }

    const existing = this.eventStore.get(input.eventId);
    if (!existing) {
      const err = new Error('not found') as Error & { code: number };
      err.code = 404;
      throw err;
    }
    if (existing.etag !== null && existing.etag !== input.ifMatchEtag) {
      const err = new Error('conflict') as Error & { code: number };
      err.code = 412;
      throw err;
    }

    const newEtag = `fake-etag-${this.patchCallCount}`;
    const updated: CalendarEventFullDetail = {
      ...existing,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.start !== undefined && input.end !== undefined ? applyTiming(input.start, input.end) : {}),
      etag: newEtag,
    };
    this.eventStore.set(input.eventId, updated);
    return { eventId: input.eventId, etag: newEtag };
  }

  async deleteEvent(_calendarId: string, eventId: string): Promise<void> {
    this.deleteCallCount += 1;
    if (this.nextDeleteEventError) {
      const throwFn = this.nextDeleteEventError;
      this.nextDeleteEventError = null;
      throwFn();
    }
    if (!this.eventStore.has(eventId)) {
      const err = new Error('not found') as Error & { code: number };
      err.code = 404;
      throw err;
    }
    this.eventStore.delete(eventId);
  }
}

function applyTiming(
  start: EventTimingField,
  end: EventTimingField,
): Pick<CalendarEventFullDetail, 'startDateTime' | 'startDate' | 'endDateTime' | 'endDate'> {
  return {
    startDateTime: 'dateTime' in start ? start.dateTime : null,
    startDate: 'date' in start ? start.date : null,
    endDateTime: 'dateTime' in end ? end.dateTime : null,
    endDate: 'date' in end ? end.date : null,
  };
}
