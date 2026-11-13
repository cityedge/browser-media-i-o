import { MediaError, type MediaErrorCode } from './errors.js';

export type VideoCopyReason = 'CONTAINER' | 'CODEC' | 'CONFIGURATION_CHANGE' | 'GOP_STRUCTURE'
  | 'DISPLAY_METADATA' | 'TIMELINE' | 'NO_SAFE_BOUNDARY' | 'EMPTY_RANGE' | 'INVALID_RANGE'
  | 'PLAN_MISMATCH' | 'PCM_LENGTH' | 'PCM_FORMAT' | 'CONFLICTING_OPTIONS' | 'LIMIT';
export class VideoCopyError extends MediaError {
  constructor(code: MediaErrorCode, public readonly reason: VideoCopyReason, message: string,
    public readonly rangeIndex?: number) { super(code, message); }
}
export function copyFail(reason: VideoCopyReason, message: string, code: MediaErrorCode = 'UNSUPPORTED', rangeIndex?: number): never {
  throw new VideoCopyError(code, reason, message, rangeIndex);
}
