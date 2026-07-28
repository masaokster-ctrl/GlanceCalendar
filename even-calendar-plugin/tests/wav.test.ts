import { describe, expect, it } from 'vitest'
import { encodeWav } from '../src/wav'

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length))
}

describe('encodeWav', () => {
  it('produces a valid RIFF/WAVE header with PCM format 1, mono, 16kHz, 16bit', () => {
    const pcm = new Uint8Array(320) // 10ms of 16kHz mono 16-bit audio
    const wav = encodeWav(pcm)
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)

    expect(readAscii(wav, 0, 4)).toBe('RIFF')
    expect(readAscii(wav, 8, 4)).toBe('WAVE')
    expect(readAscii(wav, 12, 4)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16) // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1) // PCM format code
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(16000) // sample rate
    expect(view.getUint16(34, true)).toBe(16) // bits per sample
    expect(readAscii(wav, 36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(pcm.byteLength)
  })

  it('sets the RIFF chunk size to 36 + data size', () => {
    const pcm = new Uint8Array(100)
    const wav = encodeWav(pcm)
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    expect(view.getUint32(4, true)).toBe(36 + 100)
  })

  it('computes byteRate and blockAlign correctly', () => {
    const pcm = new Uint8Array(10)
    const wav = encodeWav(pcm)
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    // blockAlign = numChannels * bitsPerSample/8 = 1 * 2 = 2
    expect(view.getUint16(32, true)).toBe(2)
    // byteRate = sampleRate * blockAlign = 16000 * 2 = 32000
    expect(view.getUint32(28, true)).toBe(32000)
  })

  it('appends the PCM data unchanged after the 44-byte header', () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5])
    const wav = encodeWav(pcm)
    expect(wav.byteLength).toBe(44 + 5)
    expect(Array.from(wav.slice(44))).toEqual([1, 2, 3, 4, 5])
  })

  it('honors custom sampleRate/numChannels/bitsPerSample options', () => {
    const pcm = new Uint8Array(8)
    const wav = encodeWav(pcm, { sampleRate: 8000, numChannels: 2, bitsPerSample: 8 })
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    expect(view.getUint32(24, true)).toBe(8000)
    expect(view.getUint16(22, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(8)
  })
})
