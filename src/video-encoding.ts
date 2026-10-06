import { Quality } from 'mediabunny';
import { fail, positive } from './errors.js';

export type VideoBitrateMode = 'variable' | 'constant' | 'quantizer';
export type VideoHardwareAcceleration = 'no-preference' | 'prefer-hardware' | 'prefer-software';
export interface VideoEncodingOptions {
  /** Target bits per second for VBR/CBR; defaults to 8,000,000. Not used by CQP. */
  videoBitrate?: number;
  /** VBR (default), CBR, or fixed H.264 quantizer (CQP). */
  videoBitrateMode?: VideoBitrateMode;
  /** Required for CQP: integer 0–51, lower values mean higher quality. */
  videoQuantizer?: number;
  /** Encoder preference hint; the browser may ignore it. */
  videoHardwareAcceleration?: VideoHardwareAcceleration;
}

/** Shared by capability checks and the actual encoder; CQP has no bitrate fallback. */
export function videoEncodingConfig(options: VideoEncodingOptions) {
  const mode = options.videoBitrateMode ?? 'variable';
  if (!['variable', 'constant', 'quantizer'].includes(mode)) fail('INVALID_ARGUMENT', 'Unsupported videoBitrateMode.');
  const hardwareAcceleration = options.videoHardwareAcceleration ?? 'no-preference';
  if (!['no-preference', 'prefer-hardware', 'prefer-software'].includes(hardwareAcceleration)) {
    fail('INVALID_ARGUMENT', 'Unsupported videoHardwareAcceleration.');
  }
  let quality: Quality;
  if (mode === 'quantizer') {
    if (!Number.isInteger(options.videoQuantizer) || options.videoQuantizer! < 0 || options.videoQuantizer! > 51) {
      fail('INVALID_ARGUMENT', 'CQP requires videoQuantizer as an integer between 0 and 51.');
    }
    if (options.videoBitrate !== undefined) fail('INVALID_ARGUMENT', 'videoBitrate cannot be combined with CQP.');
    quality = new Quality({ quantizer: options.videoQuantizer });
  } else {
    if (options.videoQuantizer !== undefined) fail('INVALID_ARGUMENT', 'videoQuantizer requires videoBitrateMode: quantizer.');
    positive(options.videoBitrate ?? 8_000_000, 'videoBitrate', true);
    quality = new Quality({ bitrate: options.videoBitrate ?? 8_000_000, bitrateMode: mode });
  }
  return { quality, hardwareAcceleration, latencyMode: 'quality' as const };
}
