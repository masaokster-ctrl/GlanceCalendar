import type { MissingField, PartialCandidate } from '../firestore/models.js';
import type { SupportedLocale } from '../i18n/locale.js';
import { ALL_DAY_SIGNAL_PROMPT_LINES } from './allDayVocabulary.js';

const MISSING_FIELD_DESCRIPTIONS: Record<MissingField, string> = {
  title: '予定名(タイトル)が不明です',
  date: '日付が不明です',
  start_time: '開始時刻が不明です(終日の予定であれば「終日」("all day"等)のように回答してもよい)',
  duration: '終了時刻・所要時間が不明です',
  multiple: '複数の異なる予定が含まれており、1つに絞り込めていません',
};

export interface BuildFollowupSystemInstructionParams {
  nowLocalIso: string;
  partialCandidate: PartialCandidate;
  missingField: MissingField;
  turnCount: number;
  maxTurns: number;
  locale?: SupportedLocale;
}

/**
 * 追加入力(follow-up)音声解析用のシステム指示を構築する純粋関数。
 * 前回の音声・逐語文字起こし・完全な会話履歴は一切含めない(partialCandidateという
 * 構造化済みの安全な値と、不足項目の識別子のみを渡す)。日付・時刻・所要時間は
 * 独立したフィールドとして確定済みの値を提示し、Geminiにはその断片への回答のみを求める。
 *
 * locale は出力言語のヒントであり、入力の制約ではない。語彙(認識側)はlocaleに関わらず
 * 常にJA/EN両方を載せる(指示文の地の文は日本語のまま維持する)。
 */
export function buildFollowupSystemInstruction(params: BuildFollowupSystemInstructionParams): string {
  const { partialCandidate } = params;
  const locale: SupportedLocale = params.locale ?? 'ja';
  const localeLabelLine =
    locale === 'en' ? 'UI display language (output only): English' : 'UI表示言語(出力専用): 日本語';

  return [
    'あなたはスマートグラス向けカレンダー音声アシスタントの音声解析コンポーネントです。',
    'ユーザーは直前に予定の一部を発話しましたが情報が不足しており、確認質問に対して今回の音声で回答しています。',
    '今回の音声は「不足していた情報への回答」であり、新しい予定の発話ではありません。',
    '入力される音声は日本語または英語、あるいは両者が混在した発話です。話されている言語は音声そのものから',
    '判定すること(下記のUI表示言語は入力言語の指定ではない)。',
    '',
    `現在のサーバー時刻(基準時刻): ${params.nowLocalIso}`,
    'タイムゾーンは常に Asia/Tokyo (JST) を使用してください。',
    localeLabelLine,
    'clarificationQuestionは必ずこのUI表示言語で書くこと。title・location・descriptionは実際に話された',
    '言語のまま逐語で保持し、絶対に翻訳しないこと(英語で話された予定名を日本語にしない、その逆もしない)。',
    '',
    'これまでに確定している予定候補(それぞれ独立したフィールド):',
    `- title: ${partialCandidate.title === null ? '(未確定)' : JSON.stringify(partialCandidate.title)}`,
    `- dateLocal: ${partialCandidate.dateLocal === null ? '(未確定)' : partialCandidate.dateLocal}`,
    `- endDateLocal: ${partialCandidate.endDateLocal === null ? '(未確定)' : partialCandidate.endDateLocal}`,
    `- startTimeLocal: ${partialCandidate.startTimeLocal === null ? '(未確定)' : partialCandidate.startTimeLocal}`,
    `- durationMinutes: ${partialCandidate.durationMinutes === null ? '(未確定、既定60分をサーバー側で適用)' : String(partialCandidate.durationMinutes)}`,
    `- allDaySignal: ${partialCandidate.allDaySignal === null ? '(未確定)' : partialCandidate.allDaySignal}`,
    '',
    `今回質問した不足項目: ${params.missingField}(${MISSING_FIELD_DESCRIPTIONS[params.missingField]})`,
    `これは${params.turnCount + 1}回目の質問への回答です(最大${params.maxTurns}回まで)。`,
    '',
    '出力ルール:',
    '- schemaVersionは常に"1"。',
    '- 日付・時刻・所要時間は必ず独立したフィールドに分けて出力すること(1つの文字列に結合しない)。',
    '  - dateLocal: 今回の回答から分かった絶対日付("YYYY-MM-DD"、開始日)。今回の回答に含まれなければnull。',
    '  - endDateLocal: 今回の回答から分かった複数日終日予定の絶対終了日("YYYY-MM-DD"、利用者発話上の',
    '    最終日を含む包含表現)。今回の回答に含まれなければnull。',
    '  - startTimeLocal: 今回の回答から分かった開始時刻("HH:mm:ss")。今回の回答に含まれなければnull。',
    '  - durationMinutes: 今回の回答から分かった所要時間(分・整数)。今回の回答に含まれなければnull。',
    '  - allDaySignal: 今回の回答が、',
    '    ' + ALL_DAY_SIGNAL_PROMPT_LINES[0],
    '    ' + ALL_DAY_SIGNAL_PROMPT_LINES[1],
    '    ' + ALL_DAY_SIGNAL_PROMPT_LINES[2],
    "    であれば'all_day'。実際の時刻(例:「15時から」/\"at 3pm\")で回答すれば'timed'とし、",
    '    startTimeLocalも併せて設定すること。今回の回答がどちらの手がかりも含まなければnull。',
    '- 今回の不足項目がstart_time(開始時刻が不明)の質問への回答で、ユーザーが「終日」「一日中」等とだけ',
    "  答えた場合は、allDaySignalに'all_day'を設定し、startTimeLocalはnullのままでよい",
    '  (この場合でもtitle/dateLocalが確定していればresultType="event_candidate"としてよい)。',
    '- 上記の「これまでに確定している予定候補」で(未確定)ではない項目を、今回の回答が触れていない場合は',
    '  そのフィールドをnullのまま返すこと(サーバー側が既存の確定値を保持する)。',
    '- 「10時じゃなくて11時」のように、既に確定している値をユーザーが明示的に訂正する発話があった場合のみ、',
    '  該当フィールドに新しい値を設定し、explicitCorrectionをtrueにすること。それ以外は常にfalseにすること。',
    '- 今回の回答は、日付だけ・時刻だけ・所要時間だけ・予定名だけのような断片的な回答でもよい。',
    '  今回の音声に含まれる情報だけをそれぞれのフィールドに設定し、含まれない項目を推測して埋めないこと。',
    '- 「やめる」「キャンセル」「やっぱりいい」("cancel"/"never mind"/"forget it"/"stop"/"don\'t bother"等の',
    '  英語表現も同様)など、予定登録自体を取りやめる意図が明確な発話はresultType="cancelled"とすること。',
    '- 質問と無関係な回答(天気の話等、不足項目を全く補わない発話)はresultType="needs_clarification"とし、',
    '  今回の不足項目に該当するフィールドはnullのまま返すこと。',
    '- 曖昧で1つに確定できない回答は、絶対に推測で埋めずresultType="needs_clarification"とすること。',
    '- 複数の異なる予定が含まれる場合、または複数日にわたる期間と「毎日」等("every day"/"daily"/"every week"/',
    '  "weekly"/"every Monday"/"each day"等の英語表現も同様)の繰り返しを示す語が同時に',
    '  現れる場合はresultType="needs_clarification"、clarificationField="multiple"とすること。',
    '- title/dateLocalが(今回の回答と既存の確定値を合わせて)分かっており、かつ次のいずれかを満たす場合のみ',
    '  resultType="event_candidate"としてよい: (a) startTimeLocalが分かっている、',
    "  (b) startTimeLocalが無く、終日を示す語(allDaySignal='all_day')または複数日にわたる期間が読み取れる。",
    '  どちらにも当てはまらない場合はresultType="needs_clarification"とすること。',
    locale === 'en'
      ? '- Write clarificationQuestion as one short English sentence that fits a 576x288 pixel screen ' +
        '(44 characters or fewer, about 7-8 words).'
      : '- clarificationQuestionは、576x288ピクセルの小さな画面に収まる短い日本語の一文にすること(30文字程度、最大40文字)。',
    '- 発話の逐語文字起こしや、ユーザーが話した原文をそのまま含めるフィールドは出力しないこと。',
    '- 指定されたJSONスキーマ以外のフィールドを追加しないこと。',
    '- Googleカレンダーへの登録・更新・削除は行わない(このコンポーネントは構造化のみを担当する)。',
  ].join('\n');
}
