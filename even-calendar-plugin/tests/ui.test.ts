import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const uiSource = readFileSync(fileURLToPath(new URL('../src/ui.ts', import.meta.url)), 'utf8')
const indexHtmlSource = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8')

describe('companion webview: no native scroll (Phase 2G scroll-bug fix)', () => {
  it('index.html sets overflow: hidden on html/body and #app (no native scrollbar)', () => {
    expect(indexHtmlSource).toMatch(/html,\s*body\s*\{[^}]*overflow:\s*hidden/s)
    expect(indexHtmlSource).toMatch(/#app\s*\{[^}]*overflow:\s*hidden/s)
  })

  it('does not use overflow: auto or overflow: scroll anywhere (would produce a native scrollbar)', () => {
    expect(indexHtmlSource).not.toMatch(/overflow(-y)?:\s*(auto|scroll)/)
    expect(uiSource).not.toMatch(/overflow(-y)?:\s*(auto|scroll)/)
  })

  it('never calls scrollIntoView or sets scrollTop (per spec: no programmatic DOM scrolling)', () => {
    expect(uiSource).not.toContain('scrollIntoView')
    expect(uiSource).not.toContain('scrollTop')
    expect(indexHtmlSource).not.toContain('scrollIntoView')
    expect(indexHtmlSource).not.toContain('scrollTop')
  })

  it('the home-screen element gets a dedicated, scoped class (not a global body-wide override)', () => {
    expect(uiSource).toContain('home-screen')
    expect(uiSource).toMatch(/\.home-screen\s*\{[^}]*overflow:\s*hidden/s)
  })

  it('the companion webview content is static and unrelated to the G2 home-menu item count (confirmed root cause is on the G2 text container, not this DOM)', () => {
    // mountUi()は起動時に固定文言だけを描画し、ホームメニュー項目やdirectoryはこの
    // webview側には一切現れない(G2実機側のtextContainerUpgradeでのみ描画される)。
    expect(uiSource).not.toContain('予定を登録')
    expect(uiSource).not.toContain('直近5件')
    expect(uiSource).not.toContain('今日の予定')
    expect(uiSource).not.toContain('明日の予定')
  })
})
