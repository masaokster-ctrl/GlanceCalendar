import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import viteConfigFactory from '../vite.config'
import { BACKEND_BASE_URL } from '../src/config'

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function loadAppJson(): {
  package_id: string
  version: string
  edition: string
  min_sdk_version: string
  permissions: Array<{ name: string; desc: string; whitelist?: string[] }>
} {
  return JSON.parse(readFileSync(path.join(rootDir, 'app.json'), 'utf8'))
}

describe('vite product mode config', () => {
  it('routes to a dedicated empty envDir only in product mode (never reads the project .env.local)', () => {
    const productConfig = (viteConfigFactory as (env: { mode: string; command: 'build'; isSsrBuild?: boolean; isPreview?: boolean }) => Record<string, unknown>)({
      mode: 'product',
      command: 'build',
    })
    expect(typeof productConfig.envDir).toBe('string')
    expect(productConfig.envDir).toContain('product-empty')

    const devConfig = (viteConfigFactory as (env: { mode: string; command: 'build'; isSsrBuild?: boolean; isPreview?: boolean }) => Record<string, unknown>)({
      mode: 'development',
      command: 'build',
    })
    expect(devConfig.envDir).toBeUndefined()
  })

  it('hard-defines the dev session token/installId to empty strings in product mode (defense in depth)', () => {
    const productConfig = (viteConfigFactory as (env: { mode: string; command: 'build' }) => { define?: Record<string, string> })({
      mode: 'product',
      command: 'build',
    })
    expect(productConfig.define?.['import.meta.env.VITE_PLUGIN_SESSION_TOKEN']).toBe('""')
    expect(productConfig.define?.['import.meta.env.VITE_PLUGIN_INSTALL_ID']).toBe('""')
  })

  it('disables source maps for the build output', () => {
    const config = (viteConfigFactory as (env: { mode: string; command: 'build' }) => { build?: { sourcemap?: boolean } })({
      mode: 'development',
      command: 'build',
    })
    expect(config.build?.sourcemap).toBe(false)
  })
})

describe('app.json manifest (Phase 2J: version 0.2.1)', () => {
  it('bumps the version to 0.2.1 while keeping package_id/edition/SDK version unchanged', () => {
    const manifest = loadAppJson()
    expect(manifest.version).toBe('0.2.1')
    expect(manifest.package_id).toBe('com.masaokster.calendarwithgemini')
    expect(manifest.edition).toBe('202601')
    expect(manifest.min_sdk_version).toBe('0.0.12')
  })

  it('declares only the permissions actually used by the app (network + g2-microphone), no unused ones', () => {
    const manifest = loadAppJson()
    const names = manifest.permissions.map((p) => p.name).sort()
    expect(names).toEqual(['g2-microphone', 'network'])
  })

  it('whitelists exactly the Cloud Run HTTPS origin for the network permission (no localhost/LAN)', () => {
    const manifest = loadAppJson()
    const networkPerm = manifest.permissions.find((p) => p.name === 'network')
    expect(networkPerm?.whitelist).toEqual(['https://even-calendar-agent-probe-1082947954310.asia-northeast1.run.app'])
    for (const url of networkPerm?.whitelist ?? []) {
      expect(url.startsWith('https://')).toBe(true)
      expect(url).not.toContain('localhost')
      expect(url).not.toContain('127.0.0.1')
      expect(url).not.toMatch(/192\.168\.|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\./)
    }
  })
})

describe('src/config.ts backend URL (Phase 2J)', () => {
  it('points to the Cloud Run HTTPS endpoint, matching the manifest whitelist exactly', () => {
    const manifest = loadAppJson()
    expect(BACKEND_BASE_URL).toBe(manifest.permissions.find((p) => p.name === 'network')?.whitelist?.[0])
    expect(BACKEND_BASE_URL.startsWith('https://')).toBe(true)
  })

  it('never points to localhost/LAN/plain-http', () => {
    expect(BACKEND_BASE_URL).not.toContain('localhost')
    expect(BACKEND_BASE_URL).not.toContain('127.0.0.1')
    expect(BACKEND_BASE_URL.startsWith('http://')).toBe(false)
  })
})
