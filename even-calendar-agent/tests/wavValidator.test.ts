import { describe, expect, it } from 'vitest';
import { validateWav } from '../src/audio/wavValidator.js';
import { buildWav } from './helpers/buildWav.js';

describe('validateWav', () => {
  it('accepts a valid mono 16kHz 16bit WAV within duration limits', () => {
    const result = validateWav(buildWav({ durationSeconds: 2 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sampleRate).toBe(16000);
      expect(result.numChannels).toBe(1);
      expect(result.bitsPerSample).toBe(16);
      expect(result.estimatedDurationMs).toBeCloseTo(2000, -1);
    }
  });

  it('rejects a buffer smaller than the minimum size', () => {
    const result = validateWav(buildWav({ durationSeconds: 0.01 }));
    expect(result).toEqual({ ok: false, reason: 'too_small' });
  });

  it('rejects a buffer larger than the maximum size', () => {
    const result = validateWav(buildWav({ durationSeconds: 40 }));
    expect(result).toEqual({ ok: false, reason: 'too_large' });
  });

  it('rejects a missing RIFF header', () => {
    const buf = buildWav({ durationSeconds: 1 });
    buf.write('XXXX', 0, 'ascii');
    expect(validateWav(buf)).toEqual({ ok: false, reason: 'invalid_riff_header' });
  });

  it('rejects a missing WAVE header', () => {
    const buf = buildWav({ durationSeconds: 1 });
    buf.write('XXXX', 8, 'ascii');
    expect(validateWav(buf)).toEqual({ ok: false, reason: 'invalid_wave_header' });
  });

  it('rejects a non-PCM format code', () => {
    const result = validateWav(buildWav({ durationSeconds: 1, formatCode: 3 }));
    expect(result).toEqual({ ok: false, reason: 'unsupported_format' });
  });

  it('rejects stereo audio', () => {
    const result = validateWav(buildWav({ durationSeconds: 1, numChannels: 2 }));
    expect(result).toEqual({ ok: false, reason: 'unsupported_channels' });
  });

  it('rejects the wrong sample rate', () => {
    const result = validateWav(buildWav({ durationSeconds: 1, sampleRate: 44100 }));
    expect(result).toEqual({ ok: false, reason: 'unsupported_sample_rate' });
  });

  it('rejects the wrong bit depth', () => {
    const result = validateWav(buildWav({ durationSeconds: 1, bitsPerSample: 8 }));
    expect(result).toEqual({ ok: false, reason: 'unsupported_bit_depth' });
  });

  it('rejects a data chunk size that does not match the actual bytes present', () => {
    const result = validateWav(buildWav({ durationSeconds: 1, dataChunkSizeOverride: 999 }));
    expect(result).toEqual({ ok: false, reason: 'data_size_mismatch' });
  });

  it('rejects audio longer than ~30 seconds', () => {
    const result = validateWav(buildWav({ durationSeconds: 35 }));
    // 35秒はサイズ上限(1,100,000バイト)にも抵触するため、いずれかの理由で拒否されることを確認する
    expect(result.ok).toBe(false);
  });

  it('rejects audio between the duration cap and the byte size cap', () => {
    // 32秒 ≈ 1,024,044バイトなのでサイズ上限(1,100,000)は超えないが、時間上限(31秒)には抵触する
    const result = validateWav(buildWav({ durationSeconds: 32 }));
    expect(result).toEqual({ ok: false, reason: 'duration_too_long' });
  });
});
