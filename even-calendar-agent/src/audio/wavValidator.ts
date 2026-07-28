const HEADER_SIZE = 44;
const MIN_BYTES = 16_044;
const MAX_BYTES = 1_100_000;
const REQUIRED_SAMPLE_RATE = 16_000;
const REQUIRED_CHANNELS = 1;
const REQUIRED_BITS_PER_SAMPLE = 16;
const REQUIRED_FORMAT_CODE = 1; // PCM
const MAX_DURATION_MS = 31_000; // 30秒 + 若干の許容

export type WavValidationErrorReason =
  | 'too_small'
  | 'too_large'
  | 'invalid_riff_header'
  | 'invalid_wave_header'
  | 'invalid_fmt_chunk'
  | 'unsupported_format'
  | 'unsupported_channels'
  | 'unsupported_sample_rate'
  | 'unsupported_bit_depth'
  | 'invalid_data_chunk'
  | 'data_size_mismatch'
  | 'duration_too_long';

export interface WavValidationOk {
  ok: true;
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  dataByteLength: number;
  estimatedDurationMs: number;
}

export interface WavValidationFailure {
  ok: false;
  reason: WavValidationErrorReason;
}

export type WavValidationResult = WavValidationOk | WavValidationFailure;

/**
 * even-calendar-pluginのencodeWav()が生成する正準44バイトヘッダーのRIFF/WAVEのみを受理する。
 * 音声内容そのものは検証結果にもログにも含めない。
 */
export function validateWav(buffer: Buffer): WavValidationResult {
  if (buffer.byteLength < MIN_BYTES) {
    return { ok: false, reason: buffer.byteLength < HEADER_SIZE ? 'invalid_riff_header' : 'too_small' };
  }
  if (buffer.byteLength > MAX_BYTES) {
    return { ok: false, reason: 'too_large' };
  }

  if (buffer.toString('ascii', 0, 4) !== 'RIFF') {
    return { ok: false, reason: 'invalid_riff_header' };
  }
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, reason: 'invalid_wave_header' };
  }
  if (buffer.toString('ascii', 12, 16) !== 'fmt ') {
    return { ok: false, reason: 'invalid_fmt_chunk' };
  }

  const fmtChunkSize = buffer.readUInt32LE(16);
  if (fmtChunkSize !== 16) {
    return { ok: false, reason: 'invalid_fmt_chunk' };
  }

  const formatCode = buffer.readUInt16LE(20);
  if (formatCode !== REQUIRED_FORMAT_CODE) {
    return { ok: false, reason: 'unsupported_format' };
  }

  const numChannels = buffer.readUInt16LE(22);
  if (numChannels !== REQUIRED_CHANNELS) {
    return { ok: false, reason: 'unsupported_channels' };
  }

  const sampleRate = buffer.readUInt32LE(24);
  if (sampleRate !== REQUIRED_SAMPLE_RATE) {
    return { ok: false, reason: 'unsupported_sample_rate' };
  }

  const bitsPerSample = buffer.readUInt16LE(34);
  if (bitsPerSample !== REQUIRED_BITS_PER_SAMPLE) {
    return { ok: false, reason: 'unsupported_bit_depth' };
  }

  if (buffer.toString('ascii', 36, 40) !== 'data') {
    return { ok: false, reason: 'invalid_data_chunk' };
  }

  const dataChunkSize = buffer.readUInt32LE(40);
  const actualDataBytes = buffer.byteLength - HEADER_SIZE;
  if (dataChunkSize !== actualDataBytes) {
    return { ok: false, reason: 'data_size_mismatch' };
  }

  const bytesPerSecond = sampleRate * numChannels * (bitsPerSample / 8);
  const estimatedDurationMs = Math.round((dataChunkSize / bytesPerSecond) * 1000);
  if (estimatedDurationMs > MAX_DURATION_MS) {
    return { ok: false, reason: 'duration_too_long' };
  }

  return { ok: true, sampleRate, numChannels, bitsPerSample, dataByteLength: dataChunkSize, estimatedDurationMs };
}

export const WAV_MAX_BYTES = MAX_BYTES;
export const WAV_MIN_BYTES = MIN_BYTES;
