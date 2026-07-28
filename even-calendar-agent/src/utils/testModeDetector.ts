export type TestMode = 'default' | 'delay-1s' | 'delay-3s' | 'delay-5s' | 'delay-10s' | 'display-length';

export const TEST_MODE_DELAY_MS: Record<TestMode, number> = {
  default: 0,
  'display-length': 0,
  'delay-1s': 1000,
  'delay-3s': 3000,
  'delay-5s': 5000,
  'delay-10s': 10000,
};

const DEFAULT_CONTENT = '接続テストに成功しました。Even AIからのリクエストを受信できています。';

const DISPLAY_LENGTH_CONTENT = [
  '表示長テストです。',
  '予定名は田中さんとの打ち合わせです。',
  '日時は7月21日火曜日の15時から16時です。',
  '場所は品川です。',
  '同じ時間帯に別の予定があります。',
  '16時から17時に変更できます。',
  'この内容で登録しますか？',
].join('\n');

export const TEST_MODE_CONTENT: Record<TestMode, string> = {
  default: DEFAULT_CONTENT,
  'delay-1s': '1秒の遅延テストに成功しました。',
  'delay-3s': '3秒の遅延テストに成功しました。',
  'delay-5s': '5秒の遅延テストに成功しました。',
  'delay-10s': '10秒の遅延テストに成功しました。',
  'display-length': DISPLAY_LENGTH_CONTENT,
};

// 前後の半角/全角空白・末尾句読点のみを取り除く（内部の文言は変更しない）。全角空白は \u3000 で表す。
const TRIM_PATTERN = /^[\s\u3000]+|[\s\u3000。、！？!?.]+$/g;

function normalize(input: string): string {
  return input.replace(TRIM_PATTERN, '');
}

const PHRASE_TO_MODE = new Map<string, TestMode>();

function register(mode: TestMode, phrases: string[]): void {
  for (const phrase of phrases) {
    PHRASE_TO_MODE.set(phrase, mode);
  }
}

register('delay-1s', ['遅延テスト1秒', '遅延テスト一秒', '1秒遅延テスト', '一秒遅延テスト']);
register('delay-3s', ['遅延テスト3秒', '遅延テスト三秒', '3秒遅延テスト', '三秒遅延テスト']);
register('delay-5s', ['遅延テスト5秒', '遅延テスト五秒', '5秒遅延テスト', '五秒遅延テスト']);
register('delay-10s', ['遅延テスト10秒', '遅延テスト十秒', '10秒遅延テスト', '十秒遅延テスト']);
register('display-length', ['表示長テスト', '表示の長さテスト', '表示文字数テスト']);

/**
 * 既知の固定フレーズと完全一致した場合のみテストモードと判定する。
 * 一般会話に含まれる数字だけで誤発動しないよう、部分一致や数字単独の検出は行わない。
 */
export function detectTestMode(content: unknown): TestMode {
  if (typeof content !== 'string') {
    return 'default';
  }

  const normalized = normalize(content);
  return PHRASE_TO_MODE.get(normalized) ?? 'default';
}
