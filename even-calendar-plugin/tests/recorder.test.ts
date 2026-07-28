import { describe, expect, it } from 'vitest'
import { PcmBuffer, bytesToSeconds, MAX_RECORDING_SECONDS, MIN_RECORDING_SECONDS } from '../src/recorder'

describe('bytesToSeconds', () => {
  it('computes seconds as byteLength / (16000 * 2)', () => {
    expect(bytesToSeconds(32000)).toBe(1)
    expect(bytesToSeconds(16000)).toBe(0.5)
    expect(bytesToSeconds(0)).toBe(0)
  })
})

describe('PcmBuffer', () => {
  it('starts empty', () => {
    const buf = new PcmBuffer()
    expect(buf.byteLength).toBe(0)
    expect(buf.seconds).toBe(0)
    expect(buf.chunkCount).toBe(0)
  })

  it('accumulates chunk byte length and count', () => {
    const buf = new PcmBuffer()
    buf.append(new Uint8Array(100))
    buf.append(new Uint8Array(200))
    expect(buf.byteLength).toBe(300)
    expect(buf.chunkCount).toBe(2)
  })

  it('concatenates chunks in order without gaps or overlaps', () => {
    const buf = new PcmBuffer()
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([4, 5])
    buf.append(a)
    buf.append(b)
    expect(Array.from(buf.concat())).toEqual([1, 2, 3, 4, 5])
  })

  it('reports 0.5s minimum as satisfied at exactly 16000 bytes', () => {
    const buf = new PcmBuffer()
    buf.append(new Uint8Array(16000))
    expect(buf.seconds).toBeCloseTo(MIN_RECORDING_SECONDS, 5)
  })

  it('caps total retained audio at 30 seconds worth of bytes', () => {
    const buf = new PcmBuffer()
    const maxBytes = MAX_RECORDING_SECONDS * 16000 * 2
    const result = buf.append(new Uint8Array(maxBytes + 1000))
    expect(result.capped).toBe(true)
    expect(buf.byteLength).toBe(maxBytes)
    expect(buf.seconds).toBeCloseTo(MAX_RECORDING_SECONDS, 5)
  })

  it('reports capped=false while under the limit and true once reached', () => {
    const buf = new PcmBuffer()
    const maxBytes = MAX_RECORDING_SECONDS * 16000 * 2
    const first = buf.append(new Uint8Array(maxBytes - 10))
    expect(first.capped).toBe(false)
    const second = buf.append(new Uint8Array(20))
    expect(second.capped).toBe(true)
    expect(buf.byteLength).toBe(maxBytes)
  })

  it('ignores further appends once already capped', () => {
    const buf = new PcmBuffer()
    const maxBytes = MAX_RECORDING_SECONDS * 16000 * 2
    buf.append(new Uint8Array(maxBytes))
    const result = buf.append(new Uint8Array(100))
    expect(result.capped).toBe(true)
    expect(buf.byteLength).toBe(maxBytes)
  })

  it('clears all state', () => {
    const buf = new PcmBuffer()
    buf.append(new Uint8Array(50))
    buf.clear()
    expect(buf.byteLength).toBe(0)
    expect(buf.chunkCount).toBe(0)
    expect(buf.concat().length).toBe(0)
  })
})
