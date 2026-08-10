import type { CurrentEventContext } from './editInstructionSchema.js';
import type { SupportedLocale } from '../i18n/locale.js';

/**
 * Gemini向けシステム指示を構築する純粋関数。発話内容そのものは含まない
 * (サーバー時刻・タイムゾーン・編集対象予定の現在値・UI表示言語のヒントのみが動的部分)。
 *
 * locale は出力言語のヒントであり、入力の制約ではない。語彙(認識側)はlocaleに関わらず
 * 常にJA/EN両方を載せる(指示文の地の文は日本語のまま維持する)。
 *
 * 現在値ラベル(予定名/開始日(時)/終了日(時)/終日予定か/場所/説明)は意図的にlocaleで
 * 切り替えない(設計§3.9)。モデルにしか見えない内部ラベルでユーザーには一切表示されないため、
 * 翻訳しても得るものが無く差分だけ増える。
 */
export function buildEditSystemInstruction(nowLocalIso: string, current: CurrentEventContext, locale: SupportedLocale = 'ja'): string {
  const localeLabelLine =
    locale === 'en' ? 'UI display language (output only): English' : 'UI表示言語(出力専用): 日本語';

  const currentLines = [
    `- 予定名: ${current.title}`,
    current.allDay ? `- 開始日: ${current.startDate ?? '不明'}` : `- 開始日時: ${current.startLocal ?? '不明'}`,
    current.allDay
      ? `- 終了日(排他的): ${current.endDateExclusive ?? '不明'}`
      : `- 終了日時: ${current.endLocal ?? '不明'}`,
    `- 終日予定か: ${current.allDay ? 'はい' : 'いいえ'}`,
    ...(current.location ? [`- 場所: ${current.location}`] : []),
    ...(current.description ? [`- 説明: ${current.description}`] : []),
  ];

  return [
    'あなたはスマートグラス向けカレンダー音声アシスタントの、既存予定の編集指示解析コンポーネントです。',
    '入力される音声は日本語または英語、あるいは両者が混在した発話であり、既に存在するカレンダー予定に',
    '対する編集指示です。話されている言語は音声そのものから判定すること(下記のUI表示言語は入力言語の',
    '指定ではない)。',
    '',
    `現在のサーバー時刻(基準時刻): ${nowLocalIso}`,
    'タイムゾーンは常に Asia/Tokyo (JST) を使用してください。',
    localeLabelLine,
    'title・location・descriptionを変更する場合、実際に話された言語のまま逐語で保持し、絶対に翻訳',
    'しないこと(英語で話された予定名を日本語にしない、その逆もしない)。',
    '',
    '編集対象の予定の現在の値:',
    ...currentLines,
    '',
    '出力ルール:',
    '- schemaVersionは常に"1"。',
    '- 発話が予定の変更指示として理解できればresultType="edit"、理解できない・カレンダー編集と無関係ならresultType="not_understood"。',
    '- 各フィールド(title/location/description/startLocal/endLocal/allDay/startDate/endDateExclusive)は、',
    '  発話がそのフィールドの変更を指示している場合のみ値を設定し、指示していないフィールドは必ずnullにすること。',
    '  (nullは「変更しない」を意味する。指示されていない項目を推測して埋めてはいけない)',
    '- 「30分後ろ」「1時間延長」「終了を30分短く」("move it 30 minutes later" / "extend by an hour" /',
    '  "shorten the end by 30 minutes"等の英語表現も同様)のような相対的な指示は、上記の現在の値と',
    '  基準時刻をもとに、実際の絶対日時("YYYY-MM-DDTHH:mm:ss")を自分で計算してstartLocal/endLocalに',
    '  設定すること。',
    '- 場所・説明を削除する指示(例:「場所を消して」「説明を削除」、英語では"clear the location" /',
    '  "delete the description"等)の場合は、そのフィールドを空文字列("")に設定すること',
    '  (nullではなく空文字列。nullは「変更しない」の意味であることに注意)。',
    '- 終日予定の日付にはstartDate("YYYY-MM-DD")/endDateExclusive("YYYY-MM-DD"、終了日は排他的)を使い、',
    '  時刻指定予定にはstartLocal/endLocalを使うこと。両方を同時に設定してはいけない。',
    '- allDayは、発話が時刻指定⇔終日の切り替えを明示的に指示している場合のみtrue/falseを設定し、',
    '  それ以外は常にnullにすること。',
    '- 曖昧で複数の解釈が可能な指示、または現在の値からは計算できない指示はresultType="not_understood"とすること。',
    '- 発話の逐語文字起こしをそのまま含めるフィールドは出力しないこと。',
    '- 指定されたJSONスキーマ以外のフィールドを追加しないこと。',
    '- Googleカレンダーへの実際の登録・更新・削除は行わない(このコンポーネントは構造化のみを担当する)。',
  ].join('\n');
}
