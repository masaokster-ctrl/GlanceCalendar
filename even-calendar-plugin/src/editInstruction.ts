// 音声による編集指示(例:「予定名を定例会議に変更」)をバックエンドが解析した結果のクライアント側の型・検証。
//
// NOTE(要フォローアップ): この形状に対応する実バックエンドエンドポイント(音声編集指示→構造化フィールド
// 差分へのGemini解析)は本実装時点では存在しない可能性が高い。既存の/plugin/analyze-audioや
// /plugin/analyze-followup-audioとは異なるスキーマが必要(diff対象フィールドの部分集合を返す形)。
// バックエンドが下記EditInstructionResult形状(resultType/fieldsのJSON)を返せるようになれば、
// parseEditInstructionResponse()はそのまま解析に使える。存在しない間、analyzeEditAudio()の呼び出しは
// 404等の失敗レスポンスとなり、editError画面(リトライ/一覧へ戻る)に到達する想定。
import { parseLocalDateTime } from './eventCandidate'
import type { EventDetail } from './eventDetail'
import { formatEventDetailWhen } from './eventDetail'

export type EditInstructionResultType = 'edit' | 'not_understood'

export interface EditInstructionFields {
  title?: string
  location?: string
  description?: string
  startLocal?: string
  endLocal?: string
  allDay?: boolean
  startDate?: string
  endDateExclusive?: string
}

export interface EditInstructionResult {
  schemaVersion: '1'
  resultType: EditInstructionResultType
  fields: EditInstructionFields
}

const LOCAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAX_TITLE_LENGTH = 120
const MAX_LOCATION_LENGTH = 200
const MAX_DESCRIPTION_LENGTH = 500

/** バックエンドのレスポンスを信頼せず、型・パターン・値域をクライアント側でも独立に再検証する。 */
export function parseEditInstructionResponse(raw: unknown): EditInstructionResult | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>

  if (r.schemaVersion !== '1') return null
  if (r.resultType !== 'edit' && r.resultType !== 'not_understood') return null

  if (r.resultType === 'not_understood') {
    return { schemaVersion: '1', resultType: 'not_understood', fields: {} }
  }

  const rawFields = r.fields
  if (typeof rawFields !== 'object' || rawFields === null) return null
  const f = rawFields as Record<string, unknown>
  const fields: EditInstructionFields = {}

  if (f.title !== undefined) {
    if (typeof f.title !== 'string' || f.title.length < 1 || f.title.length > MAX_TITLE_LENGTH) return null
    fields.title = f.title
  }
  if (f.location !== undefined) {
    if (typeof f.location !== 'string' || f.location.length > MAX_LOCATION_LENGTH) return null
    fields.location = f.location
  }
  if (f.description !== undefined) {
    if (typeof f.description !== 'string' || f.description.length > MAX_DESCRIPTION_LENGTH) return null
    fields.description = f.description
  }
  if (f.startLocal !== undefined) {
    if (typeof f.startLocal !== 'string' || !LOCAL_DATETIME_PATTERN.test(f.startLocal)) return null
    fields.startLocal = f.startLocal
  }
  if (f.endLocal !== undefined) {
    if (typeof f.endLocal !== 'string' || !LOCAL_DATETIME_PATTERN.test(f.endLocal)) return null
    fields.endLocal = f.endLocal
  }
  if (f.allDay !== undefined) {
    if (typeof f.allDay !== 'boolean') return null
    fields.allDay = f.allDay
  }
  if (f.startDate !== undefined) {
    if (typeof f.startDate !== 'string' || !LOCAL_DATE_PATTERN.test(f.startDate)) return null
    fields.startDate = f.startDate
  }
  if (f.endDateExclusive !== undefined) {
    if (typeof f.endDateExclusive !== 'string' || !LOCAL_DATE_PATTERN.test(f.endDateExclusive)) return null
    fields.endDateExclusive = f.endDateExclusive
  }

  if (Object.keys(fields).length === 0) return null

  return { schemaVersion: '1', resultType: 'edit', fields }
}

/**
 * fieldsをcurrent(直前に取得した詳細)へ重ね合わせて時刻の妥当性を検証する。start<end、終日の日付範囲、
 * timed⇔終日をまたぐ不整合な部分指定を拒否する。タイムゾーンは常にAsia/Tokyoローカル固定
 * (このアプリの既存の前提を踏襲し、新たなタイムゾーンモデルは導入しない)。
 */
export function validateEditInstructionTiming(current: EventDetail, fields: EditInstructionFields): boolean {
  const wantsTimedFields = fields.startLocal !== undefined || fields.endLocal !== undefined
  const wantsAllDayFields = fields.startDate !== undefined || fields.endDateExclusive !== undefined
  const targetAllDay = fields.allDay ?? current.allDay

  if (wantsTimedFields && targetAllDay) return false
  if (wantsAllDayFields && !targetAllDay) return false
  if (fields.allDay === undefined && !wantsTimedFields && !wantsAllDayFields) return true

  if (targetAllDay) {
    const startDate = fields.startDate ?? (current.allDay ? current.startDate : null)
    const endDateExclusive = fields.endDateExclusive ?? (current.allDay ? current.endDateExclusive : null)
    if (!startDate || !endDateExclusive) return false
    return startDate < endDateExclusive
  }

  const startLocal = fields.startLocal ?? (!current.allDay ? current.startLocal : null)
  const endLocal = fields.endLocal ?? (!current.allDay ? current.endLocal : null)
  if (!startLocal || !endLocal) return false
  if (!parseLocalDateTime(startLocal) || !parseLocalDateTime(endLocal)) return false
  return endLocal > startLocal
}

export interface EditDiffEntry {
  label: string
  before: string
  after: string
}

/**
 * 変更確認画面用に、実際に指示されたフィールドのうち現在値と異なるものだけを before→after で列挙する。
 * 説明文は内容そのものを画面に出さず「設定済み/(未設定)/(削除)」の有無のみを見せる(画面幅・プライバシー両面の配慮)。
 */
export function computeEditDiff(current: EventDetail, fields: EditInstructionFields): EditDiffEntry[] {
  const entries: EditDiffEntry[] = []

  if (fields.title !== undefined && fields.title !== current.title) {
    entries.push({ label: '予定名', before: current.title, after: fields.title })
  }

  if (fields.location !== undefined) {
    const before = current.location ?? ''
    if (fields.location !== before) {
      entries.push({ label: '場所', before: before.length > 0 ? before : '(未設定)', after: fields.location.length > 0 ? fields.location : '(削除)' })
    }
  }

  if (fields.description !== undefined) {
    const before = current.description ?? ''
    if (fields.description !== before) {
      entries.push({
        label: '説明',
        before: before.length > 0 ? '設定済み' : '(未設定)',
        after: fields.description.length > 0 ? '設定済み' : '(削除)',
      })
    }
  }

  const wantsTiming = fields.startLocal !== undefined || fields.endLocal !== undefined || fields.startDate !== undefined || fields.endDateExclusive !== undefined || fields.allDay !== undefined
  if (wantsTiming) {
    const beforeWhen = formatEventDetailWhen(current) ?? '(未設定)'
    const nextAllDay = fields.allDay ?? current.allDay
    const afterDetail: EventDetail = {
      ...current,
      allDay: nextAllDay,
      startLocal: fields.startLocal ?? (!nextAllDay ? current.startLocal : null),
      endLocal: fields.endLocal ?? (!nextAllDay ? current.endLocal : null),
      startDate: fields.startDate ?? (nextAllDay ? current.startDate : null),
      endDateExclusive: fields.endDateExclusive ?? (nextAllDay ? current.endDateExclusive : null),
    }
    const afterWhen = formatEventDetailWhen(afterDetail) ?? '(未設定)'
    if (afterWhen !== beforeWhen) {
      entries.push({ label: '日時', before: beforeWhen, after: afterWhen })
    }
  }

  return entries
}

/** computeEditDiffの結果からPATCHへ実際に送るフィールドだけを抜き出す(前後で差が無かったフィールドは送らない)。 */
export function fieldsForDiff(fields: EditInstructionFields, diff: EditDiffEntry[]): EditInstructionFields {
  const labels = new Set(diff.map((d) => d.label))
  const result: EditInstructionFields = {}
  if (labels.has('予定名') && fields.title !== undefined) result.title = fields.title
  if (labels.has('場所') && fields.location !== undefined) result.location = fields.location
  if (labels.has('説明') && fields.description !== undefined) result.description = fields.description
  if (labels.has('日時')) {
    if (fields.startLocal !== undefined) result.startLocal = fields.startLocal
    if (fields.endLocal !== undefined) result.endLocal = fields.endLocal
    if (fields.allDay !== undefined) result.allDay = fields.allDay
    if (fields.startDate !== undefined) result.startDate = fields.startDate
    if (fields.endDateExclusive !== undefined) result.endDateExclusive = fields.endDateExclusive
  }
  return result
}
