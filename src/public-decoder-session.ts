import type { AudioSample, AudioSampleSink, VideoSample, VideoSampleSink } from 'mediabunny';

export type DecoderSessionFactory = <T extends AudioSample | VideoSample>(
  sink: AudioSampleSink | VideoSampleSink, create: () => AsyncIterator<T>,
) => { iterator: AsyncIterator<T>; close(): Promise<void> };

/** Public iterator protocol only. The backend may finish cleanup after return() resolves. */
export const publicDecoderSession: DecoderSessionFactory = (_sink, create) => {
  const iterator = create();
  let cleanup: Promise<void> | undefined;
  return { iterator, close() {
    return cleanup ??= (async () => { await iterator.return?.(); })();
  } };
};
