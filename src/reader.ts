import { checkAbort, fail, mediaError, MediaError } from './errors.js';

export interface MediaReader<T> extends AsyncIterableIterator<T> {
  return(): Promise<IteratorResult<T, void>>;
}

/** Internal controller: interrupt backend work even while the consumer is paused at a yield. */
export class ReadScope {
  stopped = false;
  error?: MediaError;
  #close?: () => Promise<void>;
  #closing = Promise.resolve();
  check() { if (this.error) throw this.error; if (this.stopped) fail('ABORTED', 'The read has ended.'); }
  attach(close: () => Promise<void>) {
    this.#close = close;
    if (this.stopped) this.#startClose();
  }
  #startClose() {
    if (!this.#close) return;
    const close = this.#close; this.#close = undefined;
    this.#closing = this.#closing.then(close);
    // Consumers observe cleanup errors via return/next; abort event handlers must not leak rejections.
    this.#closing.catch(() => {});
  }
  stop(error?: MediaError) { this.error ??= error; this.stopped = true; this.#startClose(); }
  async detach() { this.#startClose(); await this.#closing; }
}

/** Lazy, single-consumer iterator with an explicit completion barrier. */
export function reader<T>(options: {
  signal?: AbortSignal;
  acquire: (scope: ReadScope) => () => void;
  generate: (scope: ReadScope) => AsyncGenerator<T, void, unknown>;
  discard: (value: T) => void;
  cleanupFailed: () => void;
}): MediaReader<T> {
  const scope = new ReadScope();
  let generator: AsyncGenerator<T, void, unknown> | undefined, release: (() => void) | undefined;
  let pending: Promise<IteratorResult<T, void>> | undefined;
  let ending: Promise<IteratorResult<T, void>> | undefined;
  let ended = false;
  const abort = () => scope.stop(new MediaError('ABORTED', 'The read was cancelled.'));
  const finish = () => ending ??= (async () => {
    scope.stop();
    try {
      try { await pending; } catch { /* next() carries the original error. */ }
      try { await generator?.return(); }
      finally { await scope.detach(); }
    } catch (error) {
      options.cleanupFailed();
      throw mediaError(error, 'DECODE_FAILED');
    } finally {
      ended = true; options.signal?.removeEventListener('abort', abort); release?.(); release = undefined;
    }
    return { value: undefined, done: true as const };
  })();
  return {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      if (ending) { await ending; if (scope.error) throw scope.error; return { done: true, value: undefined }; }
      if (ended) return { done: true, value: undefined };
      if (pending) fail('BUSY', 'Await the previous next() before requesting another item.');
      if (!generator) {
        checkAbort(options.signal);
        release = options.acquire(scope);
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
        generator = options.generate(scope);
      }
      const job = (async () => {
        const item = await generator!.next();
        if (scope.stopped && !item.done) options.discard(item.value);
        if (scope.error) throw scope.error;
        return scope.stopped ? { done: true as const, value: undefined } : item;
      })();
      pending = job;
      try {
        const item = await job;
        if (pending === job) pending = undefined;
        if (item.done) await finish();
        return item;
      } catch (error) {
        if (pending === job) pending = undefined;
        scope.stop();
        await finish();
        throw scope.error ?? mediaError(error, 'DECODE_FAILED');
      }
    },
    return: finish,
  };
}
