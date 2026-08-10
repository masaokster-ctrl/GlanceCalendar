/**
 * 終日/時刻明言の手がかり語彙 (JA/EN) の単一情報源。
 *
 * これまで systemInstruction.ts / followupSystemInstruction.ts / eventCandidateSchema.ts /
 * followupResultSchema.ts の4箇所にほぼ同一の語彙リストが重複していた。英語語彙を足すと
 * 語彙量が約2倍になりdrift確率も倍になるため、ここに集約する。
 *
 * 重要: 語彙 (認識側) はlocaleで切り替えない。locale='ja'のUIでも英語で発話されたトリガ語を
 * 認識できる必要があるため、JA/EN両方を常に載せる (設計§3.1)。切り替えるのは出力言語
 * (clarificationQuestionの言語) だけ。
 */

/** 終日/時刻明言の手がかり語(日本語)の列挙。例であり閉じたリストではない。 */
export const ALL_DAY_VOCABULARY_EXAMPLES_JA =
  '「終日」「一日中」「1日中」「有給」「有給休暇」「休暇」「休み」「夏季休暇」「年末年始休暇」';

/** 終日/時刻明言の手がかり語(英語)の列挙。例であり閉じたリストではない。 */
export const ALL_DAY_VOCABULARY_EXAMPLES_EN =
  '"all day" / "all-day" / "the whole day" / "PTO" / "day off" / "days off" / "vacation" / "holiday" / ' +
  '"off work" / "out of office"';

/**
 * @google/genai の Schema.description は単一文字列でなければならないため、この形で保持する。
 * eventCandidateSchema.ts と followupResultSchema.ts の両方でこの定数をそのまま共有すること
 * (集約後も両者は同一文字列でなければならない)。
 */
export const ALL_DAY_SIGNAL_SCHEMA_DESCRIPTION =
  '終日/時刻明言の手がかり。' +
  ALL_DAY_VOCABULARY_EXAMPLES_JA +
  '、または' +
  ALL_DAY_VOCABULARY_EXAMPLES_EN +
  '等、時刻を示さず1日(または複数日)全体を指す語(日英いずれも。これらは例であり閉じたリストではない)が' +
  "あれば'all_day'。開始時刻が明確に発話されていれば'timed'(この場合は必ずstartTimeLocalも設定する)。" +
  'どちらの手がかりも無ければnull。';

/**
 * プロンプトの [...].join('\n') 構造にそのまま展開する行配列。語彙の列挙部分のみを持ち、
 * 前後の文脈 (フィールド名・'all_day'/'timed' 判定ロジックの文言) は呼び出し側
 * (systemInstruction.ts / followupSystemInstruction.ts) で組み立てる。2ファイルで前後の
 * 文脈が異なる (初回発話向けか、追加回答向けか) ため、文脈込みでは共有できない。
 */
export const ALL_DAY_SIGNAL_PROMPT_LINES: readonly string[] = [
  ALL_DAY_VOCABULARY_EXAMPLES_JA + '、または',
  ALL_DAY_VOCABULARY_EXAMPLES_EN + '等、時刻を示さず1日(または複数日)全体を指す語(日英いずれも。',
  'これらは例であり閉じたリストではない)',
];
