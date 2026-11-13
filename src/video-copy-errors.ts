import { MediaError, type MediaErrorCode } from './errors.js';
import type { VideoCopyDiagnosticCode } from './video-copy-diagnostics.js';

export type VideoCopyReason = 'CONTAINER' | 'CODEC' | 'CONFIGURATION_CHANGE' | 'GOP_STRUCTURE'
  | 'DISPLAY_METADATA' | 'TIMELINE' | 'NO_SAFE_BOUNDARY' | 'EMPTY_RANGE' | 'INVALID_RANGE'
  | 'PLAN_MISMATCH' | 'PCM_LENGTH' | 'PCM_FORMAT' | 'CONFLICTING_OPTIONS' | 'LIMIT';
export class VideoCopyError extends MediaError {
  readonly severity = 'error';
  constructor(code: MediaErrorCode, public readonly reason: VideoCopyReason, message: string,
    public readonly rangeIndex?: number, public readonly diagnosticCode: VideoCopyDiagnosticCode | VideoCopyReason = reason,
    public readonly recoverableInContainer = false) { super(code, message); }
}
export function copyFail(reason: VideoCopyReason, message: string, code: MediaErrorCode = 'UNSUPPORTED', rangeIndex?: number): never {
  throw new VideoCopyError(code, reason, message, rangeIndex);
}
/** A failed independent-GOP proof; other parsing/configuration errors remain fatal. */
export function copyProofFail(code: VideoCopyDiagnosticCode, message: string, reason: VideoCopyReason = 'GOP_STRUCTURE'): never {
  throw new VideoCopyError('UNSUPPORTED', reason, message, undefined, code, true);
}
