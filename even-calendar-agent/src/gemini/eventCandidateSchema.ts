import { Type } from '@google/genai';
import type { Schema } from '@google/genai';
import { parseGeminiFragmentOutput, type ClarificationField, type GeminiFragmentOutput } from './candidateFragments.js';

export type ResultType = 'event_candidate' | 'needs_clarification' | 'not_calendar_request';
export type { ClarificationField };

/**
 * クライアント(plugin)へ返す最終形。startLocal/endLocalはサーバーがfragmentsから組み立てた完成値
 * (通常予定のみ非null、終日予定・未完成時はnull)。startDate/endDateExclusiveは終日予定完成時のみ
 * 設定する(値が無ければキー自体を省略する。endDateExclusiveはGoogle Calendar API方式の排他的
 * 終了日、包含最終日+1)。
 */
export interface EventCandidateResult {
  schemaVersion: '1';
  resultType: ResultType;
  title: string | null;
  startLocal: string | null;
  endLocal: string | null;
  startDate?: string;
  endDateExclusive?: string;
  timeZone: 'Asia/Tokyo';
  allDay: boolean;
  clarificationField: ClarificationField | null;
  clarificationQuestion: string | null;
  assumptions: string[];
}

const RESULT_TYPES: readonly ResultType[] = ['event_candidate', 'needs_clarification', 'not_calendar_request'];

/** @google/genai の responseSchema に渡すJSON Schema相当の定義。日付・時刻・所要時間を独立したフィールドで持つ。 */
export const EVENT_CANDIDATE_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    schemaVersion: { type: Type.STRING, enum: ['1'] },
    resultType: { type: Type.STRING, enum: [...RESULT_TYPES] },
    title: { type: Type.STRING, nullable: true },
    dateLocal: { type: Type.STRING, nullable: true, description: 'YYYY-MM-DD形式(Asia/Tokyo基準の絶対日付、開始日)' },
    endDateLocal: {
      type: Type.STRING,
      nullable: true,
      description:
        '複数日にわたる終日予定の場合の絶対終了日(YYYY-MM-DD、利用者発話上は最終日を含む包含表現)。' +
        '単日の予定や通常(時刻指定)予定ではnull。',
    },
    startTimeLocal: { type: Type.STRING, nullable: true, description: 'HH:mm:ss形式' },
    durationMinutes: { type: Type.INTEGER, nullable: true },
    allDaySignal: {
      type: Type.STRING,
      enum: ['all_day', 'timed'],
      nullable: true,
      description:
        "終日/時刻明言の手がかり。「終日」「一日中」「有給」「休暇」「休み」等、時刻を示さず1日(または複数日)全体を" +
        "指す語があれば'all_day'。開始時刻が明確に発話されていれば'timed'(この場合は必ずstartTimeLocalも設定する)。" +
        'どちらの手がかりも無ければnull。',
    },
    timeZone: { type: Type.STRING, enum: ['Asia/Tokyo'] },
    explicitCorrection: { type: Type.BOOLEAN },
    clarificationField: { type: Type.STRING, enum: ['title', 'date', 'start_time', 'duration', 'multiple'], nullable: true },
    clarificationQuestion: { type: Type.STRING, nullable: true },
    assumptions: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['schemaVersion', 'resultType', 'timeZone', 'explicitCorrection', 'assumptions'],
  propertyOrdering: [
    'schemaVersion',
    'resultType',
    'title',
    'dateLocal',
    'endDateLocal',
    'startTimeLocal',
    'durationMinutes',
    'allDaySignal',
    'timeZone',
    'explicitCorrection',
    'clarificationField',
    'clarificationQuestion',
    'assumptions',
  ],
};

/**
 * Geminiの生JSONを検証する(初回analyze-audio用。resultTypeに"cancelled"は許可しない)。
 * 不正ならnull(呼び出し側は502として扱う)。startLocal/endLocalの組み立てとmissingFieldの
 * 最終判定はresolveCandidate(candidateFragments.ts)の責務。
 */
export function parseInitialFragmentResult(raw: unknown): GeminiFragmentOutput | null {
  return parseGeminiFragmentOutput(raw, RESULT_TYPES);
}
