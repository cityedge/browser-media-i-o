export type MediaErrorCode = 'INVALID_ARGUMENT' | 'UNSUPPORTED' | 'CLOSED' | 'BUSY' | 'ABORTED' | 'RESOURCE_LIMIT' | 'DECODE_FAILED' | 'ENCODE_FAILED';

export class MediaError extends Error {
  constructor(public readonly code: MediaErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MediaError';
  }
}

export function fail(code: MediaErrorCode, message: string): never { throw new MediaError(code, message); }
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) fail('ABORTED', 'The operation was cancelled.');
}
export function positive(value: number, name: string, integer = false): void {
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    fail('INVALID_ARGUMENT', `${name} must be a positive ${integer ? 'safe integer' : 'number'}.`);
  }
}
export function nonnegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) fail('INVALID_ARGUMENT', `${name} must be a finite, non-negative number.`);
}
export function mediaError(error: unknown, code: MediaErrorCode): MediaError {
  return error instanceof MediaError ? error : new MediaError(code, error instanceof Error ? error.message : String(error), { cause: error });
}

// Some browser operations (notably decodeAudioData) cannot be interrupted internally.
// Reject promptly while still observing the eventual settlement to avoid unhandled rejections.
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new MediaError('ABORTED', 'The operation was cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
