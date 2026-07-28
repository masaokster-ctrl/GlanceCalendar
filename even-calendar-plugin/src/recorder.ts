const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2

export const MAX_RECORDING_SECONDS = 30
export const MIN_RECORDING_SECONDS = 0.5
const MAX_BYTES = MAX_RECORDING_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE

export function bytesToSeconds(byteLength: number): number {
  return byteLength / (SAMPLE_RATE * BYTES_PER_SAMPLE)
}

export interface AppendResult {
  capped: boolean
}

/** G2マイクのPCMチャンクを最大30秒分だけメモリ上に保持するバッファ。内容はログに出さない。 */
export class PcmBuffer {
  private chunks: Uint8Array[] = []
  private totalBytes = 0

  append(chunk: Uint8Array): AppendResult {
    if (this.totalBytes >= MAX_BYTES) {
      return { capped: true }
    }
    const remaining = MAX_BYTES - this.totalBytes
    const toAppend = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk
    this.chunks.push(toAppend)
    this.totalBytes += toAppend.byteLength
    return { capped: this.totalBytes >= MAX_BYTES }
  }

  get byteLength(): number {
    return this.totalBytes
  }

  get seconds(): number {
    return bytesToSeconds(this.totalBytes)
  }

  get chunkCount(): number {
    return this.chunks.length
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.totalBytes)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    return out
  }

  clear(): void {
    this.chunks = []
    this.totalBytes = 0
  }
}
