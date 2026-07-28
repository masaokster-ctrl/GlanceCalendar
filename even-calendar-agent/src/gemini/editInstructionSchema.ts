import { Type } from '@google/genai';
import type { Schema } from '@google/genai';

export type EditInstructionResultType = 'edit' | 'not_understood';

const RESULT_TYPES: readonly EditInstructionResultType[] = ['edit', 'not_understood'];
const LOCAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TITLE_LENGTH = 120;
const MAX_LOCATION_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 500;
const ALLOWED_KEYS = new Set([
  'schemaVersion',
  'resultType',
  'title',
  'location',
  'description',
  'startLocal',
  'endLocal',
  'allDay',
  'startDate',
  'endDateExclusive',
]);

/** @google/genai の responseSchema に渡すJSON Schema相当の定義。nullは「このフィールドは変更しない」を表す。 */
export const EDIT_INSTRUCTION_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    schemaVersion: { type: Type.STRING, enum: ['1'] },
    resultType: { type: Type.STRING, enum: [...RESULT_TYPES] },
    title: { type: Type.STRING, nullable: true },
    location: { type: Type.STRING, nullable: true, description: '削除指示は空文字列、変更しない場合はnull' },
    description: { type: Type.STRING, nullable: true, description: '削除指示は空文字列、変更しない場合はnull' },
    startLocal: { type: Type.STRING, nullable: true, description: 'YYYY-MM-DDTHH:mm:ss形式(Asia/Tokyoローカル)' },
    endLocal: { type: Type.STRING, nullable: true, description: 'YYYY-MM-DDTHH:mm:ss形式(Asia/Tokyoローカル)' },
    allDay: { type: Type.BOOLEAN, nullable: true },
    startDate: { type: Type.STRING, nullable: true, description: 'YYYY-MM-DD形式' },
    endDateExclusive: { type: Type.STRING, nullable: true, description: 'YYYY-MM-DD形式(終了日は排他的)' },
  },
  required: ['schemaVersion', 'resultType'],
  propertyOrdering: [
    'schemaVersion',
    'resultType',
    'title',
    'location',
    'description',
    'startLocal',
    'endLocal',
    'allDay',
    'startDate',
    'endDateExclusive',
  ],
};

/** Geminiの生JSON出力を検証後の形。nullは「変更しない」、空文字列(location/description)は「削除」を表す。 */
export interface EditInstructionGeminiOutput {
  resultType: EditInstructionResultType;
  title: string | null;
  location: string | null;
  description: string | null;
  startLocal: string | null;
  endLocal: string | null;
  allDay: boolean | null;
  startDate: string | null;
  endDateExclusive: string | null;
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

/**
 * Geminiの生JSONを信頼せず、型・enum値・日付/時刻フォーマット・長さを個別に検証する。
 * 1つでも不正、または未知のフィールドを含む場合はnull(呼び出し側は502として扱う)。
 */
export function parseEditInstructionGeminiOutput(raw: unknown): EditInstructionGeminiOutput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  for (const key of Object.keys(r)) {
    if (!ALLOWED_KEYS.has(key)) return null;
  }

  if (r.schemaVersion !== '1') return null;
  if (typeof r.resultType !== 'string' || !RESULT_TYPES.includes(r.resultType as EditInstructionResultType)) return null;

  if (!isNullableString(r.title) || (typeof r.title === 'string' && (r.title.length < 1 || r.title.length > MAX_TITLE_LENGTH))) return null;
  if (!isNullableString(r.location) || (typeof r.location === 'string' && r.location.length > MAX_LOCATION_LENGTH)) return null;
  if (!isNullableString(r.description) || (typeof r.description === 'string' && r.description.length > MAX_DESCRIPTION_LENGTH)) return null;
  if (!isNullableString(r.startLocal) || (typeof r.startLocal === 'string' && !LOCAL_DATETIME_PATTERN.test(r.startLocal))) return null;
  if (!isNullableString(r.endLocal) || (typeof r.endLocal === 'string' && !LOCAL_DATETIME_PATTERN.test(r.endLocal))) return null;
  if (r.allDay !== null && r.allDay !== undefined && typeof r.allDay !== 'boolean') return null;
  if (!isNullableString(r.startDate) || (typeof r.startDate === 'string' && !LOCAL_DATE_PATTERN.test(r.startDate))) return null;
  if (!isNullableString(r.endDateExclusive) || (typeof r.endDateExclusive === 'string' && !LOCAL_DATE_PATTERN.test(r.endDateExclusive)))
    return null;

  const hasTimedFields = (r.startLocal ?? null) !== null || (r.endLocal ?? null) !== null;
  const hasAllDayFields = (r.startDate ?? null) !== null || (r.endDateExclusive ?? null) !== null;
  if (hasTimedFields && hasAllDayFields) return null; // 時刻指定と終日の日付を同時に指定する矛盾した出力

  return {
    resultType: r.resultType as EditInstructionResultType,
    title: (r.title ?? null) as string | null,
    location: (r.location ?? null) as string | null,
    description: (r.description ?? null) as string | null,
    startLocal: (r.startLocal ?? null) as string | null,
    endLocal: (r.endLocal ?? null) as string | null,
    allDay: (r.allDay ?? null) as boolean | null,
    startDate: (r.startDate ?? null) as string | null,
    endDateExclusive: (r.endDateExclusive ?? null) as string | null,
  };
}

/** 現在の予定の値(Gemini向けプロンプト・差分計算の両方で使う)。空/未設定のlocation/descriptionはキー省略。 */
export interface CurrentEventContext {
  title: string;
  allDay: boolean;
  startLocal?: string;
  endLocal?: string;
  startDate?: string;
  endDateExclusive?: string;
  location?: string;
  description?: string;
}

export type EditInternalReason = 'no_change' | 'ambiguous_instruction' | 'invalid_datetime' | 'unsupported_change';

export interface EditFields {
  title?: string;
  location?: string;
  description?: string;
  startLocal?: string;
  endLocal?: string;
  allDay?: boolean;
  startDate?: string;
  endDateExclusive?: string;
}

export type ResolveEditInstructionResult = { kind: 'edit'; fields: EditFields } | { kind: 'not_understood'; reason: EditInternalReason };

/**
 * 検証済みGemini出力を現在の予定へ重ね合わせ、実際にplugin/PATCHへ渡すべきfields差分だけを算出する。
 * 現在値と同じ値しか含まれない場合はno_changeとしてnot_understood扱いにする(no-op検出)。
 * plugin側のvalidateEditInstructionTiming/computeEditDiff(editInstruction.ts)と同じ前提
 * (timed⇔all-dayの部分指定拒否、start<end必須)をサーバー側でも独立に検証する。
 */
export function resolveEditInstruction(current: CurrentEventContext, output: EditInstructionGeminiOutput): ResolveEditInstructionResult {
  if (output.resultType === 'not_understood') {
    return { kind: 'not_understood', reason: 'ambiguous_instruction' };
  }

  const wantsTimedFields = output.startLocal !== null || output.endLocal !== null;
  const wantsAllDayFields = output.startDate !== null || output.endDateExclusive !== null;
  const targetAllDay = output.allDay ?? current.allDay;

  if (wantsTimedFields && targetAllDay) return { kind: 'not_understood', reason: 'unsupported_change' };
  if (wantsAllDayFields && !targetAllDay) return { kind: 'not_understood', reason: 'unsupported_change' };
  const switchingType = output.allDay !== null && output.allDay !== current.allDay;
  if (switchingType && !wantsTimedFields && !wantsAllDayFields) {
    // allDayの切り替えだけ指示されて新しい日時が伴っていない: 範囲を計算できないため拒否する
    return { kind: 'not_understood', reason: 'unsupported_change' };
  }

  const fields: EditFields = {};

  if (output.title !== null && output.title !== current.title) {
    fields.title = output.title;
  }
  if (output.location !== null) {
    const before = current.location ?? '';
    if (output.location !== before) fields.location = output.location;
  }
  if (output.description !== null) {
    const before = current.description ?? '';
    if (output.description !== before) fields.description = output.description;
  }

  const wantsTiming = wantsTimedFields || wantsAllDayFields || switchingType;
  if (wantsTiming) {
    if (targetAllDay) {
      const startDate = output.startDate ?? (current.allDay ? current.startDate : undefined);
      const endDateExclusive = output.endDateExclusive ?? (current.allDay ? current.endDateExclusive : undefined);
      if (!startDate || !endDateExclusive || !(startDate < endDateExclusive)) {
        return { kind: 'not_understood', reason: 'invalid_datetime' };
      }
      if (switchingType || startDate !== current.startDate) fields.startDate = startDate;
      if (switchingType || endDateExclusive !== current.endDateExclusive) fields.endDateExclusive = endDateExclusive;
      if (switchingType) fields.allDay = targetAllDay;
    } else {
      const startLocal = output.startLocal ?? (!current.allDay ? current.startLocal : undefined);
      const endLocal = output.endLocal ?? (!current.allDay ? current.endLocal : undefined);
      if (!startLocal || !endLocal || !(startLocal < endLocal)) {
        return { kind: 'not_understood', reason: 'invalid_datetime' };
      }
      if (switchingType || startLocal !== current.startLocal) fields.startLocal = startLocal;
      if (switchingType || endLocal !== current.endLocal) fields.endLocal = endLocal;
      if (switchingType) fields.allDay = targetAllDay;
    }
  }

  if (Object.keys(fields).length === 0) {
    return { kind: 'not_understood', reason: 'no_change' };
  }

  return { kind: 'edit', fields };
}
