import { BACKEND_BASE_URL } from './config'

// コンパニオンWebView側の最小限の表示。実際のUIはG2側のテキストコンテナで完結する。
// 「スマホでコードを入力する」リンクは既存の/connectをそのまま開くだけ(新規APIは追加しない)。
// リンクの表示文言には生のURLを含めない(押せば開けることが分かれば十分で、読み上げ・手入力させる
// 必要は無いため)。
export function mountUi(): void {
  const app = document.querySelector<HTMLDivElement>('#app')
  if (!app) return
  app.innerHTML = `
    <main class="panel home-screen">
      <h1>Even Calendar</h1>
      <p id="status">起動中…</p>
      <p id="connect-action" style="margin-top:16px; display:none;">
        <a id="connect-link" href="${BACKEND_BASE_URL}/connect">スマホでコードを入力する</a>
      </p>
    </main>
  `
  injectStyles()
}

export function setCompanionStatus(text: string): void {
  const el = document.querySelector<HTMLParagraphElement>('#status')
  if (el) el.textContent = text
}

/** Glass側がpairing画面(コード表示・接続待ち)の間だけ、この導線を表示する。app.ts側が
 *  pairing開始/終了のタイミングで呼び出す想定。 */
export function setConnectActionVisible(visible: boolean): void {
  const el = document.querySelector<HTMLParagraphElement>('#connect-action')
  if (el) el.style.display = visible ? 'block' : 'none'
}

function injectStyles(): void {
  const css = `
    :root { color-scheme: dark; }
    html, body { margin: 0; height: 100%; background: #232323; color: #E5E5E5;
      font: 16px/1.4 -apple-system, BlinkMacSystemFont, 'Helvetica Neue', system-ui, sans-serif;
      touch-action: manipulation; -webkit-text-size-adjust: 100%; overscroll-behavior: none; }
    #app { display: flex; align-items: center; justify-content: center; height: 100%; }
    .panel { text-align: center; padding: 24px; }
    h1 { font-size: 18px; font-weight: 600; margin: 0 0 12px; }
    #status { font-size: 13px; color: #A7A7A7; }
    #connect-action a { color: #8AB4F8; font-size: 15px; }
    /* ホーム画面専用: ネイティブスクロールバー・スクロールを禁止する(bodyへの一般適用ではなくこの要素に限定)。 */
    .home-screen { width: 100%; height: 100%; margin: 0; padding: 24px; box-sizing: border-box; overflow: hidden; }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
