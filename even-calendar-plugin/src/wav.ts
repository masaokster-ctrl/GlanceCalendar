export interface WavOptions {
  sampleRate?: number
  numChannels?: number
  bitsPerSample?: number
}

/**
 * PCM s16le データからRIFF/WAVEヘッダー付きのWAVバイト列を生成するユーティリティ。
 * このフェーズでは保存・送信のいずれにも使用しない(将来の解析フェーズに向けた実装のみ)。
 */
export function encodeWav(pcm: Uint8Array, options: WavOptions = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 16000
  const numChannels = options.numChannels ?? 1
  const bitsPerSample = options.bitsPerSample ?? 16
  const blockAlign = numChannels * (bitsPerSample / 8)
  const byteRate = sampleRate * blockAlign
  const dataSize = pcm.byteLength

  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  writeAsciiString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAsciiString(view, 8, 'WAVE')
  writeAsciiString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmtチャンクサイズ(PCMは常に16)
  view.setUint16(20, 1, true) // フォーマットコード: 1 = PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeAsciiString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  const bytes = new Uint8Array(buffer)
  bytes.set(pcm, 44)
  return bytes
}

function writeAsciiString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i += 1) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}
