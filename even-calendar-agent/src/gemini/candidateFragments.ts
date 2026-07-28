import { DateTime } from 'luxon';

export type ClarificationField = 'title' | 'date' | 'start_time' | 'duration' | 'multiple';
export type ResolvedResultType = 'event_candidate' | 'needs_clarification' | 'cancelled' | 'not_calendar_request';
/** 終日/時刻明言の手がかり。'all_day'=終日語のみ、'timed'=時刻明言、null=どちらの手がかりも無し(models.tsのPartialCandidate.allDaySignalと同じ意味)。 */
export type AllDaySignal = 'all_day' | 'timed';

const TOKYO_ZONE = 'Asia/Tokyo';
const DEFAULT_DURATION_MINUTES = 60;

export const CLARIFICATION_FIELDS: readonly ClarificationField[] = ['title', 'date', 'start_time', 'duration', 'multiple'];
export const ALL_DAY_SIGNAL_VALUES: readonly AllDaySignal[] = ['all_day', 'timed'];
export const DATE_LOCAL_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_LOCAL_PATTERN = /^\d{2}:\d{2}:\d{2}$/;
export const MIN_DURATION_MINUTES = 1;
export const MAX_DURATION_MINUTES = 10080;
export const MAX_TITLE_LENGTH = 200;
export const MAX_QUESTION_LENGTH = 200;
export const MAX_ASSUMPTIONS = 10;
export const MAX_ASSUMPTION_LENGTH = 100;

/**
 * 日付・時刻・所要時間を独立して保持する中間状態(Firestoreのpartial candidateと同じ形)。
 * endDateLocalは複数日終日候補の絶対終了日(包含的、dateLocal以上)。allDaySignalは終日/時刻明言の手がかり。
 * どちらも内部的には包含表現のまま保持し、包含→排他(Google API形式)への変換はresolveCandidate内でのみ行う。
 */
export interface CandidateFragments {
  title: string | null;
  dateLocal: string | null;
  startTimeLocal: string | null;
  durationMinutes: number | null;
  endDateLocal: string | null;
  allDaySignal: AllDaySignal | null;
}

export const BLANK_FRAGMENTS: CandidateFragments = {
  title: null,
  dateLocal: null,
  startTimeLocal: null,
  durationMinutes: null,
  endDateLocal: null,
  allDaySignal: null,
};

/** Geminiの生JSON出力を検証後の形。startLocal/endLocal/startDate/endDateExclusiveの組み立てはサーバー側の責務とし、Geminiには持たせない。 */
export interface GeminiFragmentOutput {
  resultType: ResolvedResultType;
  title: string | null;
  dateLocal: string | null;
  startTimeLocal: string | null;
  durationMinutes: number | null;
  endDateLocal: string | null;
  allDaySignal: AllDaySignal | null;
  explicitCorrection: boolean;
  clarificationField: ClarificationField | null;
  clarificationQuestion: string | null;
  assumptions: string[];
}

/**
 * startLocal/endLocalは通常(時刻指定)予定完成時のみ非null、startDate/endDateExclusiveは終日予定完成時のみ
 * 非null(PluginEventCandidateTimingと同じ判別だが、event_candidate以外のresultTypeも表現するため
 * 厳密な判別可能ユニオンにはせず、該当しない側は常にnullで表す)。endDateExclusiveはGoogle Calendar API
 * 方式の排他的終了日(包含最終日+1)。
 */
export interface ResolvedCandidate {
  mergedFragments: CandidateFragments;
  resultType: ResolvedResultType;
  title: string | null;
  startLocal: string | null;
  endLocal: string | null;
  startDate: string | null;
  endDateExclusive: string | null;
  timeZone: 'Asia/Tokyo';
  allDay: boolean;
  clarificationField: ClarificationField | null;
  clarificationQuestion: string | null;
  assumptions: string[];
}

/**
 * null または文字列を受け入れる(undefined = キー省略も許容する)。スキーマ上nullable:trueかつ
 * requiredに含まれないフィールドは、Geminiがnullを明示せずキー自体を省略してくる場合があるため。
 */
function isNullableString(v: unknown): v is string | null | undefined {
  return v === null || v === undefined || typeof v === 'string';
}

/**
 * Geminiの生JSONを信頼せず、型・enum値・日付/時刻フォーマット・長さを個別に検証する。
 * 1つでも不正ならnullを返す(呼び出し側は502として扱う)。逐語文字起こしや自由文は
 * 受け取らない設計(スキーマにフィールド自体が存在しない)。startLocal/endLocalの組み立てや
 * clarificationFieldの最終判定はここでは行わない(resolveCandidateの責務)。
 */
export function parseGeminiFragmentOutput(raw: unknown, allowedResultTypes: readonly ResolvedResultType[]): GeminiFragmentOutput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (r.schemaVersion !== '1') return null;
  if (typeof r.resultType !== 'string' || !allowedResultTypes.includes(r.resultType as ResolvedResultType)) return null;
  if (!isNullableString(r.title) || (typeof r.title === 'string' && r.title.length > MAX_TITLE_LENGTH)) return null;

  if (!isNullableString(r.dateLocal)) return null;
  if (typeof r.dateLocal === 'string' && !DATE_LOCAL_PATTERN.test(r.dateLocal)) return null;

  if (!isNullableString(r.startTimeLocal)) return null;
  if (typeof r.startTimeLocal === 'string' && !TIME_LOCAL_PATTERN.test(r.startTimeLocal)) return null;

  if (r.durationMinutes !== null && r.durationMinutes !== undefined) {
    if (
      typeof r.durationMinutes !== 'number' ||
      !Number.isInteger(r.durationMinutes) ||
      r.durationMinutes < MIN_DURATION_MINUTES ||
      r.durationMinutes > MAX_DURATION_MINUTES
    ) {
      return null;
    }
  }

  if (!isNullableString(r.endDateLocal)) return null;
  if (typeof r.endDateLocal === 'string' && !DATE_LOCAL_PATTERN.test(r.endDateLocal)) return null;

  if (
    r.allDaySignal !== null &&
    r.allDaySignal !== undefined &&
    (typeof r.allDaySignal !== 'string' || !ALL_DAY_SIGNAL_VALUES.includes(r.allDaySignal as AllDaySignal))
  ) {
    return null;
  }

  if (r.timeZone !== 'Asia/Tokyo') return null;
  if (typeof r.explicitCorrection !== 'boolean') return null;

  if (
    r.clarificationField !== null &&
    r.clarificationField !== undefined &&
    (typeof r.clarificationField !== 'string' || !CLARIFICATION_FIELDS.includes(r.clarificationField as ClarificationField))
  ) {
    return null;
  }

  if (
    !isNullableString(r.clarificationQuestion) ||
    (typeof r.clarificationQuestion === 'string' && r.clarificationQuestion.length > MAX_QUESTION_LENGTH)
  ) {
    return null;
  }

  if (
    !Array.isArray(r.assumptions) ||
    r.assumptions.length > MAX_ASSUMPTIONS ||
    !r.assumptions.every((a) => typeof a === 'string' && a.length <= MAX_ASSUMPTION_LENGTH)
  ) {
    return null;
  }

  return {
    resultType: r.resultType as ResolvedResultType,
    title: (r.title ?? null) as string | null,
    dateLocal: (r.dateLocal ?? null) as string | null,
    startTimeLocal: (r.startTimeLocal ?? null) as string | null,
    durationMinutes: (r.durationMinutes ?? null) as number | null,
    endDateLocal: (r.endDateLocal ?? null) as string | null,
    allDaySignal: (r.allDaySignal ?? null) as AllDaySignal | null,
    explicitCorrection: r.explicitCorrection,
    clarificationField: (r.clarificationField ?? null) as ClarificationField | null,
    clarificationQuestion: (r.clarificationQuestion ?? null) as string | null,
    assumptions: r.assumptions as string[],
  };
}

function pick<T>(existingVal: T | null, incomingVal: T | null, allowOverwrite: boolean): T | null {
  if (incomingVal === null) return existingVal;
  if (existingVal === null) return incomingVal;
  return allowOverwrite ? incomingVal : existingVal;
}

/**
 * dateLocalが明示的に訂正された場合、古いendDateLocal(旧開始日に紐づく期間の終了日)をそのまま
 * 引き継ぐと逆転期間(終了<開始)を生みかねないため、dateLocalの訂正時はendDateLocalも今回の発話の
 * 値で置き換える(今回言及が無ければnull=単日扱いに戻す)。それ以外は通常のpick()と同じ規則に従う。
 */
function mergeEndDateLocal(existing: CandidateFragments, incoming: GeminiFragmentOutput, allowOverwrite: boolean): string | null {
  if (allowOverwrite && incoming.dateLocal !== null) {
    return incoming.endDateLocal;
  }
  return pick(existing.endDateLocal, incoming.endDateLocal, allowOverwrite);
}

function mergeFragments(existing: CandidateFragments, incoming: GeminiFragmentOutput): CandidateFragments {
  const allowOverwrite = incoming.explicitCorrection === true;
  return {
    title: pick(existing.title, incoming.title, allowOverwrite),
    dateLocal: pick(existing.dateLocal, incoming.dateLocal, allowOverwrite),
    startTimeLocal: pick(existing.startTimeLocal, incoming.startTimeLocal, allowOverwrite),
    durationMinutes: pick(existing.durationMinutes, incoming.durationMinutes, allowOverwrite),
    endDateLocal: mergeEndDateLocal(existing, incoming, allowOverwrite),
    allDaySignal: pick(existing.allDaySignal, incoming.allDaySignal, allowOverwrite),
  };
}

function assembleLocalDateTime(
  dateLocal: string,
  startTimeLocal: string,
  durationMinutes: number,
): { startLocal: string; endLocal: string } | null {
  const start = DateTime.fromISO(`${dateLocal}T${startTimeLocal}`, { zone: TOKYO_ZONE });
  if (!start.isValid) return null;
  const end = start.plus({ minutes: durationMinutes });
  if (!end.isValid) return null;
  return {
    startLocal: start.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    endLocal: end.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
  };
}

/**
 * 終日予定の絶対開始日・絶対終了日(共に利用者発話上は包含)から、Google Calendar API方式の
 * 排他的終了日(endDateExclusive = 包含最終日 + 1日)を組み立てる。包含→排他の+1日変換を行うのは
 * このリポジトリ全体でここ1箇所のみとする(候補の完成判定であるresolveCandidateの内部)。
 * 月またぎ・年またぎ・うるう年はLuxonのDateTime演算に委ねる(固定ミリ秒演算や文字列操作は行わない)。
 * 存在しない日付(例: 2月30日)や逆転期間(終了<開始)はnullを返し、呼び出し側で再確認扱いにする。
 */
function resolveAllDayRange(dateLocal: string, endDateLocalInclusive: string | null): { startDate: string; endDateExclusive: string } | null {
  const start = DateTime.fromISO(dateLocal, { zone: TOKYO_ZONE });
  if (!start.isValid) return null;

  const inclusiveEndSource = endDateLocalInclusive ?? dateLocal;
  const inclusiveEnd = DateTime.fromISO(inclusiveEndSource, { zone: TOKYO_ZONE });
  if (!inclusiveEnd.isValid) return null;

  if (inclusiveEnd < start) return null;

  const endDateExclusive = inclusiveEnd.plus({ days: 1 });

  return {
    startDate: start.toFormat('yyyy-MM-dd'),
    endDateExclusive: endDateExclusive.toFormat('yyyy-MM-dd'),
  };
}

/** 早期return用の「まだ候補が確定していない」形。startLocal/endLocal/startDate/endDateExclusiveは全てnull。 */
function unresolvedResult(
  mergedFragments: CandidateFragments,
  resultType: ResolvedResultType,
  clarificationField: ClarificationField | null,
  clarificationQuestion: string | null,
  assumptions: string[],
): ResolvedCandidate {
  return {
    mergedFragments,
    resultType,
    title: null,
    startLocal: null,
    endLocal: null,
    startDate: null,
    endDateExclusive: null,
    timeZone: 'Asia/Tokyo',
    allDay: false,
    clarificationField,
    clarificationQuestion,
    assumptions,
  };
}

/**
 * Gemini出力を既存fragmentsへ安全にmergeし、resultType/missingFieldをサーバー側で
 * 再判定する(GeminiのresultType/clarificationFieldを無条件には信用しない)。
 * "multiple"だけはfragmentsから導出できない信号のため、Geminiの申告をそのまま採用する。
 * 過去日時・end<=startはここで再検証し、不正ならneeds_clarification(missingField=date)へ降格する。
 *
 * 終日/複数日判定: 明確な時刻(startTimeLocal)がある場合は常に通常予定を優先する(設計要件3)。
 * 時刻が無く、終日を示す語(allDaySignal='all_day')または実際に開始日と異なるendDateLocalが
 * 与えられていれば終日予定として完成させる。日付だけで時刻も終日の手がかりも無い場合は
 * 自動的にどちらか決めず、start_timeの再確認へ回す(設計要件3・japanese-date-rangeスキル参照)。
 * 「Xから Yまで毎日10時」のような繰り返し予定が複数日の範囲と時刻を同時に含む場合は、単一の
 * 終日/通常予定へ誤って潰さず、未対応としてclarificationField="multiple"へ倒す(設計要件6)。
 */
export function resolveCandidate(existing: CandidateFragments, incoming: GeminiFragmentOutput, nowLocal: string): ResolvedCandidate {
  if (incoming.resultType === 'cancelled' || incoming.resultType === 'not_calendar_request') {
    return unresolvedResult(existing, incoming.resultType, null, null, incoming.assumptions);
  }

  const merged = mergeFragments(existing, incoming);

  if (incoming.clarificationField === 'multiple') {
    return unresolvedResult(merged, 'needs_clarification', 'multiple', incoming.clarificationQuestion, incoming.assumptions);
  }

  let missingField: ClarificationField | null = null;
  if (merged.title === null) missingField = 'title';
  else if (merged.dateLocal === null) missingField = 'date';

  if (missingField !== null) {
    return unresolvedResult(merged, 'needs_clarification', missingField, incoming.clarificationQuestion, incoming.assumptions);
  }

  const dateLocal = merged.dateLocal as string;
  const isRangeGiven = merged.endDateLocal !== null && merged.endDateLocal !== dateLocal;

  // 「8月3日から8月5日まで毎日10時に会議」のような繰り返し予定の誤変換を防ぐ: 複数日の範囲と
  // 時刻の両方が同時に指定された場合は、単一の終日/通常予定へ潰さず未対応として明確化を求める。
  if (merged.startTimeLocal !== null && isRangeGiven) {
    return unresolvedResult(merged, 'needs_clarification', 'multiple', '複数日にわたる繰り返し予定には対応していません', incoming.assumptions);
  }

  const isAllDay = merged.startTimeLocal === null && (merged.allDaySignal === 'all_day' || isRangeGiven);

  if (isAllDay) {
    const range = resolveAllDayRange(dateLocal, merged.endDateLocal);
    if (!range) {
      return unresolvedResult(
        { ...merged, dateLocal: null, endDateLocal: null },
        'needs_clarification',
        'date',
        '日付を確認できませんでした。もう一度お試しください',
        incoming.assumptions,
      );
    }

    return {
      mergedFragments: merged,
      resultType: 'event_candidate',
      title: merged.title,
      startLocal: null,
      endLocal: null,
      startDate: range.startDate,
      endDateExclusive: range.endDateExclusive,
      timeZone: 'Asia/Tokyo',
      allDay: true,
      clarificationField: null,
      clarificationQuestion: null,
      assumptions: incoming.assumptions,
    };
  }

  if (merged.startTimeLocal === null) {
    // 日付だけ・終日の手がかりも時刻も無い曖昧な発話。自動的にどちらとも決めず再確認する。
    return unresolvedResult(merged, 'needs_clarification', 'start_time', incoming.clarificationQuestion, incoming.assumptions);
  }

  const assumptions = [...incoming.assumptions];
  let durationMinutes = merged.durationMinutes;
  if (durationMinutes === null) {
    durationMinutes = DEFAULT_DURATION_MINUTES;
    if (!assumptions.includes('duration_defaulted')) assumptions.push('duration_defaulted');
  }

  const finalFragments: CandidateFragments = { ...merged, durationMinutes };
  const assembled = assembleLocalDateTime(dateLocal, merged.startTimeLocal, durationMinutes);

  if (!assembled || assembled.startLocal < nowLocal || assembled.endLocal <= assembled.startLocal) {
    // 日付が原因の不整合とみなし、dateLocalのみ再確認対象として解放する(時刻・タイトルは維持)。
    return unresolvedResult(
      { ...finalFragments, dateLocal: null },
      'needs_clarification',
      'date',
      '過去の日時のようです。もう一度お試しください',
      assumptions,
    );
  }

  return {
    mergedFragments: finalFragments,
    resultType: 'event_candidate',
    title: merged.title,
    startLocal: assembled.startLocal,
    endLocal: assembled.endLocal,
    startDate: null,
    endDateExclusive: null,
    timeZone: 'Asia/Tokyo',
    allDay: false,
    clarificationField: null,
    clarificationQuestion: null,
    assumptions,
  };
}
