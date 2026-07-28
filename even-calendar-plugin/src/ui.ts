// コンパニオンWebView側の最小限の表示。実際のUIはG2側のテキストコンテナで完結する。
export function mountUi(): void {
  const app = document.querySelector<HTMLDivElement>('#app')
  if (!app) return
  app.innerHTML = `
    <main class="panel home-screen">
      <h1>Even Calendar</h1>
      <p id="status">起動中…</p>
    </main>
  `
  injectStyles()
}

export function setCompanionStatus(text: string): void {
  const el = document.querySelector<HTMLParagraphElement>('#status')
  if (el) el.textContent = text
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
    /* ホーム画面専用: ネイティブスクロールバー・スクロールを禁止する(bodyへの一般適用ではなくこの要素に限定)。 */
    .home-screen { width: 100%; height: 100%; margin: 0; padding: 24px; box-sizing: border-box; overflow: hidden; }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
