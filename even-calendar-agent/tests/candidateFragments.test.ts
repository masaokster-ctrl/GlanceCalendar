import { describe, expect, it } from 'vitest';
import {
  resolveCandidate,
  parseGeminiFragmentOutput,
  BLANK_FRAGMENTS,
  type CandidateFragments,
  type GeminiFragmentOutput,
} from '../src/gemini/candidateFragments.js';

const NOW = '2026-07-22T10:00:00';

function fragmentOutput(overrides: Partial<GeminiFragmentOutput> = {}): GeminiFragmentOutput {
  return {
    resultType: 'needs_clarification',
    title: null,
    dateLocal: null,
    startTimeLocal: null,
    durationMinutes: null,
    endDateLocal: null,
    allDaySignal: null,
    explicitCorrection: false,
    clarificationField: null,
    clarificationQuestion: null,
    assumptions: [],
    ...overrides,
  };
}

function fragments(overrides: Partial<CandidateFragments> = {}): CandidateFragments {
  return { ...BLANK_FRAGMENTS, ...overrides };
}

describe('resolveCandidate', () => {
  it('case1: 初回「明日、打ち合わせ」相当 - title/dateLocal既知、start_time不足', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'needs_clarification', title: '打ち合わせ', dateLocal: '2026-07-23', clarificationField: 'start_time' }),
      NOW,
    );
    expect(resolved.resultType).toBe('needs_clarification');
    expect(resolved.clarificationField).toBe('start_time');
    expect(resolved.mergedFragments.dateLocal).toBe('2026-07-23');
  });

  it('case2: follow-up「午後3時」相当 - 既存のdateLocalを保持したままstart_timeを補って完成する(実機不具合の直接回帰確認)', () => {
    const existing = fragments({ title: '打ち合わせ', dateLocal: '2026-07-23' });
    // Geminiが誤ってclarificationField='date'を返しても、mergedFragmentsのdateLocalは既知なのでサーバーが上書きする。
    const resolved = resolveCandidate(
      existing,
      fragmentOutput({ resultType: 'needs_clarification', startTimeLocal: '15:00:00', clarificationField: 'date' }),
      NOW,
    );
    expect(resolved.resultType).toBe('event_candidate');
    expect(resolved.startLocal).toBe('2026-07-23T15:00:00');
    expect(resolved.endLocal).toBe('2026-07-23T16:00:00');
    expect(resolved.assumptions).toContain('duration_defaulted');
  });

  it('case3: 初回「午後3時から打ち合わせ」相当 - title/startTimeLocal既知、date不足', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'needs_clarification', title: '打ち合わせ', startTimeLocal: '15:00:00', clarificationField: 'date' }),
      NOW,
    );
    expect(resolved.resultType).toBe('needs_clarification');
    expect(resolved.clarificationField).toBe('date');
    expect(resolved.mergedFragments.startTimeLocal).toBe('15:00:00');
  });

  it('case4: follow-up「明日」相当 - 既存のstartTimeLocalを保持したままdateLocalを補って完成する', () => {
    const existing = fragments({ title: '打ち合わせ', startTimeLocal: '15:00:00' });
    const resolved = resolveCandidate(existing, fragmentOutput({ resultType: 'needs_clarification', dateLocal: '2026-07-23' }), NOW);
    expect(resolved.resultType).toBe('event_candidate');
    expect(resolved.startLocal).toBe('2026-07-23T15:00:00');
  });

  it('初回「日付＋時刻」、タイトル不足 → date/timeを保持したままtitle不足で再質問', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'needs_clarification', dateLocal: '2026-07-23', startTimeLocal: '15:00:00', clarificationField: 'title' }),
      NOW,
    );
    expect(resolved.resultType).toBe('needs_clarification');
    expect(resolved.clarificationField).toBe('title');
    expect(resolved.mergedFragments.dateLocal).toBe('2026-07-23');
    expect(resolved.mergedFragments.startTimeLocal).toBe('15:00:00');
  });

  it('follow-up「タイトルのみ」→ date/timeを維持したまま完成する', () => {
    const existing = fragments({ dateLocal: '2026-07-23', startTimeLocal: '15:00:00' });
    const resolved = resolveCandidate(existing, fragmentOutput({ resultType: 'needs_clarification', title: '打ち合わせ' }), NOW);
    expect(resolved.resultType).toBe('event_candidate');
    expect(resolved.title).toBe('打ち合わせ');
    expect(resolved.startLocal).toBe('2026-07-23T15:00:00');
  });

  it('Geminiが既存確定値をnullで返しても消さない(explicitCorrectionなし)', () => {
    const existing = fragments({ title: '打ち合わせ', dateLocal: '2026-07-23', startTimeLocal: '15:00:00' });
    const resolved = resolveCandidate(existing, fragmentOutput({ resultType: 'needs_clarification', title: null, dateLocal: null }), NOW);
    // 何も新しい情報が無い(無関係な回答)ので、既存値を維持したまま完成しているはず
    expect(resolved.resultType).toBe('event_candidate');
    expect(resolved.title).toBe('打ち合わせ');
    expect(resolved.startLocal).toBe('2026-07-23T15:00:00');
  });

  it('explicitCorrectionがfalseの場合、異なる値が来ても既存の確定値を変更しない', () => {
    const existing = fragments({ title: '打ち合わせ', dateLocal: '2026-07-23', startTimeLocal: '10:00:00' });
    const resolved = resolveCandidate(
      existing,
      fragmentOutput({ resultType: 'needs_clarification', startTimeLocal: '15:00:00', explicitCorrection: false }),
      NOW,
    );
    expect(resolved.startLocal).toBe('2026-07-23T10:00:00');
  });

  it('explicitCorrection=trueの場合のみ既存の確定値を上書きする', () => {
    const existing = fragments({ title: '打ち合わせ', dateLocal: '2026-07-23', startTimeLocal: '10:00:00' });
    const resolved = resolveCandidate(
      existing,
      fragmentOutput({ resultType: 'needs_clarification', startTimeLocal: '15:00:00', explicitCorrection: true }),
      NOW,
    );
    expect(resolved.startLocal).toBe('2026-07-23T15:00:00');
  });

  it('dateLocal既知時には日付の再質問(missingField=date)を返さない', () => {
    const existing = fragments({ title: '打ち合わせ', dateLocal: '2026-07-23' });
    const resolved = resolveCandidate(existing, fragmentOutput({ resultType: 'needs_clarification', startTimeLocal: null }), NOW);
    expect(resolved.clarificationField).not.toBe('date');
    expect(resolved.clarificationField).toBe('start_time');
  });

  it('durationMinutes未指定時は60分を既定値として適用し、duration_defaultedを付与する', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: '打ち合わせ', dateLocal: '2026-07-23', startTimeLocal: '15:00:00' }),
      NOW,
    );
    expect(resolved.resultType).toBe('event_candidate');
    expect(resolved.endLocal).toBe('2026-07-23T16:00:00');
    expect(resolved.assumptions).toContain('duration_defaulted');
  });

  it('durationMinutesが明示されていれば60分既定を適用しない', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({
        resultType: 'event_candidate',
        title: '打ち合わせ',
        dateLocal: '2026-07-23',
        startTimeLocal: '15:00:00',
        durationMinutes: 30,
      }),
      NOW,
    );
    expect(resolved.endLocal).toBe('2026-07-23T15:30:00');
    expect(resolved.assumptions).not.toContain('duration_defaulted');
  });

  it('過去日時はevent_candidateにせず、dateLocalをクリアして再質問する', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: '打ち合わせ', dateLocal: '2020-01-01', startTimeLocal: '10:00:00' }),
      NOW,
    );
    expect(resolved.resultType).toBe('needs_clarification');
    expect(resolved.clarificationField).toBe('date');
    expect(resolved.mergedFragments.dateLocal).toBeNull();
    // 時刻・タイトルは再質問の原因ではないため維持される
    expect(resolved.mergedFragments.startTimeLocal).toBe('10:00:00');
    expect(resolved.mergedFragments.title).toBe('打ち合わせ');
  });

  it('Asia/Tokyoの日付境界(23:xx台の開始+60分繰り上がり)を正しく計算する', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: '夜の予定', dateLocal: '2026-07-23', startTimeLocal: '23:30:00' }),
      NOW,
    );
    expect(resolved.resultType).toBe('event_candidate');
    expect(resolved.startLocal).toBe('2026-07-23T23:30:00');
    expect(resolved.endLocal).toBe('2026-07-24T00:30:00');
  });

  it('明示的なキャンセル("やめる"相当)はresultType=cancelledをそのまま通す', () => {
    const existing = fragments({ title: '打ち合わせ', dateLocal: '2026-07-23' });
    const resolved = resolveCandidate(existing, fragmentOutput({ resultType: 'cancelled' }), NOW);
    expect(resolved.resultType).toBe('cancelled');
    expect(resolved.title).toBeNull();
  });

  it('not_calendar_requestはそのまま通す', () => {
    const resolved = resolveCandidate(BLANK_FRAGMENTS, fragmentOutput({ resultType: 'not_calendar_request' }), NOW);
    expect(resolved.resultType).toBe('not_calendar_request');
  });

  it('clarificationField="multiple"はfragmentsの充足状況によらずそのまま信頼する', () => {
    const existing = fragments({ title: '打ち合わせ', dateLocal: '2026-07-23', startTimeLocal: '15:00:00' });
    const resolved = resolveCandidate(
      existing,
      fragmentOutput({ resultType: 'needs_clarification', clarificationField: 'multiple' }),
      NOW,
    );
    expect(resolved.resultType).toBe('needs_clarification');
    expect(resolved.clarificationField).toBe('multiple');
  });

  it('end<=startになり得ない設計だが、不正な日時アセンブリはdateへ降格させる(防御的フォールバック)', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: '打ち合わせ', dateLocal: '2026-02-30', startTimeLocal: '15:00:00' }),
      NOW,
    );
    expect(resolved.resultType).toBe('needs_clarification');
    expect(resolved.clarificationField).toBe('date');
  });
});

describe('resolveCandidate: 終日・複数日予定', () => {
  it('単日終日(「8月3日は終日休暇」相当) - allDay=true、startDate/endDateExclusiveがともに単日分', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: '休暇', dateLocal: '2026-08-03', allDaySignal: 'all_day' }),
      NOW,
    );
    expect(resolved.resultType).toBe('event_candidate');
    expect(resolved.allDay).toBe(true);
    expect(resolved.startLocal).toBeNull();
    expect(resolved.endLocal).toBeNull();
    expect(resolved.startDate).toBe('2026-08-03');
    expect(resolved.endDateExclusive).toBe('2026-08-04');
  });

  it('複数日終日(「8月3日から8月5日まで出張」相当) - endDateExclusiveは最終日+1', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: '出張', dateLocal: '2026-08-03', endDateLocal: '2026-08-05' }),
      NOW,
    );
    expect(resolved.resultType).toBe('event_candidate');
    expect(resolved.allDay).toBe(true);
    expect(resolved.startDate).toBe('2026-08-03');
    expect(resolved.endDateExclusive).toBe('2026-08-06');
  });

  it('複数日の範囲は終日を示す語(allDaySignal)が無くても終日として解決する(期間そのものが手がかり)', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: '出張', dateLocal: '2026-08-30', endDateLocal: '2026-09-02', allDaySignal: null }),
      NOW,
    );
    expect(resolved.resultType).toBe('event_candidate');
    expect(resolved.allDay).toBe(true);
  });

  it('「3日間」(開始日を1日目とする) - 8/3から3日間 → endDateExclusive=8/6', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      // Geminiが「3日間」をendDateLocal(開始日+2日、包含)に解決した結果を模する。
      fragmentOutput({ resultType: 'event_candidate', title: '休み', dateLocal: '2026-08-03', endDateLocal: '2026-08-05' }),
      NOW,
    );
    expect(resolved.startDate).toBe('2026-08-03');
    expect(resolved.endDateExclusive).toBe('2026-08-06');
  });

  it('「1週間」(開始日を1日目とする) - 8/3から1週間 → endDateExclusive=8/10', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: '出張', dateLocal: '2026-08-03', endDateLocal: '2026-08-09' }),
      NOW,
    );
    expect(resolved.startDate).toBe('2026-08-03');
    expect(resolved.endDateExclusive).toBe('2026-08-10');
  });

  it('月またぎ(「8月30日から9月2日まで出張」相当)を正しく解決する', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: '出張', dateLocal: '2026-08-30', endDateLocal: '2026-09-02' }),
      NOW,
    );
    expect(resolved.startDate).toBe('2026-08-30');
    expect(resolved.endDateExclusive).toBe('2026-09-03');
  });

  it('年またぎ(「12月29日から1月3日まで休暇」相当)を正しく解決する', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: '休暇', dateLocal: '2026-12-29', endDateLocal: '2027-01-03' }),
      NOW,
    );
    expect(resolved.startDate).toBe('2026-12-29');
    expect(resolved.endDateExclusive).toBe('2027-01-04');
  });

  it('うるう年(2024年2月29日)をまたぐ終了日を正しく解決する', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: '休暇', dateLocal: '2024-02-28', endDateLocal: '2024-02-29' }),
      NOW,
    );
    expect(resolved.startDate).toBe('2024-02-28');
    expect(resolved.endDateExclusive).toBe('2024-03-01');
  });

  it('存在しない日付(2月30日)を終了日に含む場合は拒否し、日付を再確認する', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: '休暇', dateLocal: '2026-08-03', endDateLocal: '2026-02-30' }),
      NOW,
    );
    expect(resolved.resultType).toBe('needs_clarification');
    expect(resolved.clarificationField).toBe('date');
    expect(resolved.mergedFragments.dateLocal).toBeNull();
  });

  it('逆転期間(終了日<開始日)は拒否し、日付を再確認する', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: '休暇', dateLocal: '2026-08-05', endDateLocal: '2026-08-03' }),
      NOW,
    );
    expect(resolved.resultType).toBe('needs_clarification');
    expect(resolved.clarificationField).toBe('date');
  });

  it('日付だけで終日の手がかりも時刻も無い場合は自動的に終日にせず、start_timeの再確認にする', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'needs_clarification', title: '会議', dateLocal: '2026-08-03' }),
      NOW,
    );
    expect(resolved.resultType).toBe('needs_clarification');
    expect(resolved.clarificationField).toBe('start_time');
    expect(resolved.mergedFragments.dateLocal).toBe('2026-08-03');
  });

  it('follow-upで「終日」と回答すると、start_time待ちの候補が終日予定として完成する', () => {
    const existing = fragments({ title: '休暇', dateLocal: '2026-08-03' });
    const resolved = resolveCandidate(existing, fragmentOutput({ resultType: 'event_candidate', allDaySignal: 'all_day' }), NOW);
    expect(resolved.resultType).toBe('event_candidate');
    expect(resolved.allDay).toBe(true);
    expect(resolved.startDate).toBe('2026-08-03');
    expect(resolved.endDateExclusive).toBe('2026-08-04');
  });

  it('明確な時刻があれば終日の手がかりより通常予定を優先する(「8月3日の10時から有給の手続き」相当)', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({
        resultType: 'event_candidate',
        title: '有給の手続き',
        dateLocal: '2026-08-03',
        startTimeLocal: '10:00:00',
        allDaySignal: 'all_day',
      }),
      NOW,
    );
    expect(resolved.resultType).toBe('event_candidate');
    expect(resolved.allDay).toBe(false);
    expect(resolved.startLocal).toBe('2026-08-03T10:00:00');
    expect(resolved.endLocal).toBe('2026-08-03T11:00:00');
  });

  it('複数日の期間と時刻が同時に指定された繰り返し予定は誤って1件に潰さず、multipleで再確認する(「8/3から8/5まで毎日10時に会議」相当)', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({
        resultType: 'event_candidate',
        title: '会議',
        dateLocal: '2026-08-03',
        endDateLocal: '2026-08-05',
        startTimeLocal: '10:00:00',
      }),
      NOW,
    );
    expect(resolved.resultType).toBe('needs_clarification');
    expect(resolved.clarificationField).toBe('multiple');
  });

  it('dateLocalが明示的に訂正された場合、古いendDateLocalを引き継がず単日扱いにリセットする', () => {
    const existing = fragments({ title: '出張', dateLocal: '2026-08-03', endDateLocal: '2026-08-05' });
    const resolved = resolveCandidate(
      existing,
      fragmentOutput({
        resultType: 'event_candidate',
        dateLocal: '2026-08-10',
        allDaySignal: 'all_day',
        explicitCorrection: true,
      }),
      NOW,
    );
    expect(resolved.resultType).toBe('event_candidate');
    expect(resolved.allDay).toBe(true);
    expect(resolved.startDate).toBe('2026-08-10');
    expect(resolved.endDateExclusive).toBe('2026-08-11');
  });
});

describe('resolveCandidate: locale引数(設計§4.2、案(A)) - サーバー側フォールバック文言3本', () => {
  it('繰り返し未対応: locale省略時は既存の日本語文言と一字一句同じ', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({
        resultType: 'event_candidate',
        title: '会議',
        dateLocal: '2026-08-03',
        endDateLocal: '2026-08-05',
        startTimeLocal: '10:00:00',
      }),
      NOW,
    );
    expect(resolved.resultType).toBe('needs_clarification');
    expect(resolved.clarificationField).toBe('multiple');
    expect(resolved.clarificationQuestion).toBe('複数日にわたる繰り返し予定には対応していません');
  });

  it('繰り返し未対応: locale="ja"を明示しても省略時と同一の日本語文言', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({
        resultType: 'event_candidate',
        title: '会議',
        dateLocal: '2026-08-03',
        endDateLocal: '2026-08-05',
        startTimeLocal: '10:00:00',
      }),
      NOW,
      'ja',
    );
    expect(resolved.clarificationQuestion).toBe('複数日にわたる繰り返し予定には対応していません');
  });

  it('繰り返し未対応: locale="en"では英語の文言("Recurring events aren\'t supported.", 34字)', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({
        resultType: 'event_candidate',
        title: 'Meeting',
        dateLocal: '2026-08-03',
        endDateLocal: '2026-08-05',
        startTimeLocal: '10:00:00',
      }),
      NOW,
      'en',
    );
    expect(resolved.clarificationQuestion).toBe("Recurring events aren't supported.");
    expect(resolved.clarificationQuestion?.length).toBe(34);
  });

  it('日付解決失敗(存在しない終了日): locale省略時は既存の日本語文言と一字一句同じ', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: '休暇', dateLocal: '2026-08-03', endDateLocal: '2026-02-30' }),
      NOW,
    );
    expect(resolved.resultType).toBe('needs_clarification');
    expect(resolved.clarificationQuestion).toBe('日付を確認できませんでした。もう一度お試しください');
  });

  it('日付解決失敗: locale="en"では英語の文言("Couldn\'t read the date. Try again.", 34字)', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: 'Vacation', dateLocal: '2026-08-03', endDateLocal: '2026-02-30' }),
      NOW,
      'en',
    );
    expect(resolved.clarificationQuestion).toBe("Couldn't read the date. Try again.");
    expect(resolved.clarificationQuestion?.length).toBe(34);
  });

  it('過去日時: locale省略時は既存の日本語文言と一字一句同じ', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: '打ち合わせ', dateLocal: '2020-01-01', startTimeLocal: '10:00:00' }),
      NOW,
    );
    expect(resolved.resultType).toBe('needs_clarification');
    expect(resolved.clarificationQuestion).toBe('過去の日時のようです。もう一度お試しください');
  });

  it('過去日時: locale="en"では英語の文言("That time has already passed. Try again.", 40字)', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: 'Meeting', dateLocal: '2020-01-01', startTimeLocal: '10:00:00' }),
      NOW,
      'en',
    );
    expect(resolved.clarificationQuestion).toBe('That time has already passed. Try again.');
    expect(resolved.clarificationQuestion?.length).toBe(40);
  });

  it('英語3本は全て60字の検証済みハードリミット(even-calendar-plugin/src/screens.ts MAX_DISPLAY_LENGTH)以内', () => {
    const HARD_LIMIT = 60; // 検証済み。これのみをハード判定に使う(44は助言的ターゲットに過ぎない)。
    const recurring = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({
        resultType: 'event_candidate',
        title: 'Meeting',
        dateLocal: '2026-08-03',
        endDateLocal: '2026-08-05',
        startTimeLocal: '10:00:00',
      }),
      NOW,
      'en',
    );
    const dateUnresolvable = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: 'Vacation', dateLocal: '2026-08-03', endDateLocal: '2026-02-30' }),
      NOW,
      'en',
    );
    const pastDatetime = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: 'Meeting', dateLocal: '2020-01-01', startTimeLocal: '10:00:00' }),
      NOW,
      'en',
    );
    for (const r of [recurring, dateUnresolvable, pastDatetime]) {
      expect(r.clarificationQuestion).not.toBeNull();
      expect(r.clarificationQuestion!.length).toBeLessThanOrEqual(HARD_LIMIT);
      // 44字は助言的ターゲットの参考アサート(超過してもテスト失敗にはしない設計なので、
      // ここでは実測値が34/34/40であることの記録としてのみ確認する)。
      expect(r.clarificationQuestion!.length).toBeLessThanOrEqual(44);
    }
  });

  it('timeZone!=="Asia/Tokyo"はlocaleの有無に関わらず引き続きparseGeminiFragmentOutputでnullを返す(不変条件の回帰確認)', () => {
    const raw = {
      schemaVersion: '1',
      resultType: 'event_candidate',
      title: 'x',
      dateLocal: '2026-08-03',
      startTimeLocal: '10:00:00',
      durationMinutes: 60,
      endDateLocal: null,
      allDaySignal: null,
      timeZone: 'UTC',
      explicitCorrection: false,
      clarificationField: null,
      clarificationQuestion: null,
      assumptions: [],
    };
    expect(parseGeminiFragmentOutput(raw, ['event_candidate', 'needs_clarification', 'not_calendar_request'])).toBeNull();
  });

  it('locale="en"を渡しても終日の包含→排他変換(月またぎ・年またぎ・うるう年)は不変', () => {
    const monthRollover = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: 'Trip', dateLocal: '2026-08-30', endDateLocal: '2026-09-02' }),
      NOW,
      'en',
    );
    expect(monthRollover.startDate).toBe('2026-08-30');
    expect(monthRollover.endDateExclusive).toBe('2026-09-03');

    const yearRollover = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: 'Vacation', dateLocal: '2026-12-29', endDateLocal: '2027-01-03' }),
      NOW,
      'en',
    );
    expect(yearRollover.startDate).toBe('2026-12-29');
    expect(yearRollover.endDateExclusive).toBe('2027-01-04');

    const leapYear = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({ resultType: 'event_candidate', title: 'Vacation', dateLocal: '2024-02-28', endDateLocal: '2024-02-29' }),
      NOW,
      'en',
    );
    expect(leapYear.startDate).toBe('2024-02-28');
    expect(leapYear.endDateExclusive).toBe('2024-03-01');
  });

  it('locale="en"を渡しても「複数日の期間+時刻」→clarificationField="multiple"の挙動は不変', () => {
    const resolved = resolveCandidate(
      BLANK_FRAGMENTS,
      fragmentOutput({
        resultType: 'event_candidate',
        title: 'Meeting',
        dateLocal: '2026-08-03',
        endDateLocal: '2026-08-05',
        startTimeLocal: '10:00:00',
      }),
      NOW,
      'en',
    );
    expect(resolved.resultType).toBe('needs_clarification');
    expect(resolved.clarificationField).toBe('multiple');
  });
});
