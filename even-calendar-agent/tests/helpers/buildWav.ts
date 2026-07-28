export interface BuildWavOptions {
  sampleRate?: number;
  numChannels?: number;
  bitsPerSample?: number;
  durationSeconds?: number;
  formatCode?: number;
  fmtChunkSize?: number;
  dataChunkSizeOverride?: number;
}

/** テスト専用のWAVバッファ生成ヘルパー。even-calendar-pluginのencodeWav()と同じ44バイトヘッダー構造。 */
export function buildWav(options: BuildWavOptions = {}): Buffer {
  const sampleRate = options.sampleRate ?? 16000;
  const numChannels = options.numChannels ?? 1;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const durationSeconds = options.durationSeconds ?? 1;
  const formatCode = options.formatCode ?? 1;
  const fmtChunkSize = options.fmtChunkSize ?? 16;

  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = Math.round(sampleRate * durationSeconds) * blockAlign;
  const declaredDataSize = options.dataChunkSizeOverride ?? dataSize;

  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(fmtChunkSize, 16);
  buffer.writeUInt16LE(formatCode, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(declaredDataSize, 40);
  return buffer;
}
