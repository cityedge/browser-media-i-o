import { abortable, checkAbort, fail, MediaError, mediaError, positive } from './errors.js';
import { mp3WorkerSource } from './mp3-worker-source.js';
import { readWav, type PcmSource } from './mp3/wav.js';

export { MediaError } from './errors.js';

/** AudioBuffer or an equivalent planar floating-point PCM object. */
export interface Mp3Audio {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

export interface Mp3Options {
  /** Bits per second. Default: 192000 for >=32 kHz, 128000 for lower rates. CBR. */
  bitrate?: number;
  signal?: AbortSignal;
  /** Monotonic fraction, from 0 to 1. A value of 1 means the MP3 is complete. */
  onProgress?: (fraction: number) => void;
  /** Maximum MP3 size in bytes. Default: 256 MiB. */
  maxOutputBytes?: number;
}

export interface WavToMp3Options extends Mp3Options {
  /** Maximum WAV size in bytes, checked before reading a Blob. Default: 256 MiB. */
  maxInputBytes?: number;
}

/** Encode finished audio to MP3. The input is neither modified nor transferred. */
export async function encodeMp3(audio: Mp3Audio, options: Mp3Options = {}): Promise<Blob> {
  checkAbort(options.signal);
  if (!audio || typeof audio.getChannelData !== 'function') fail('INVALID_ARGUMENT', 'Expected an AudioBuffer or Mp3Audio.');
  positive(audio.length, 'audio.length', true);
  if (![1, 2].includes(audio.numberOfChannels)) fail('UNSUPPORTED', 'MP3 export supports mono and stereo only.');
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
  if (channels.some(c => !(c instanceof Float32Array) || c.length !== audio.length)) {
    fail('INVALID_ARGUMENT', 'PCM channels must be Float32Arrays of the same length.');
  }
  return encode({
    sampleRate: audio.sampleRate, channels: audio.numberOfChannels, length: audio.length,
    read: (offset, count) => channels.map(c => new Float32Array(c.subarray(offset, offset + count))),
  }, options);
}

/** Convert an already generated PCM WAV Blob/File/ArrayBuffer to MP3. */
export async function wavToMp3(wav: Blob | ArrayBuffer, options: WavToMp3Options = {}): Promise<Blob> {
  checkAbort(options.signal);
  const limit = options.maxInputBytes ?? 256 * 1024 * 1024;
  positive(limit, 'maxInputBytes', true);
  if (!(wav instanceof Blob) && !(wav instanceof ArrayBuffer)) fail('INVALID_ARGUMENT', 'Expected a WAV Blob or ArrayBuffer.');
  const size = wav instanceof Blob ? wav.size : wav.byteLength;
  if (size > limit) fail('RESOURCE_LIMIT', 'WAV exceeds maxInputBytes.');
  const buffer = wav instanceof Blob ? await abortable(wav.arrayBuffer(), options.signal) : wav;
  checkAbort(options.signal);
  return encode(readWav(buffer), options);
}

async function encode(source: PcmSource, options: Mp3Options): Promise<Blob> {
  const { signal, onProgress } = options;
  checkAbort(signal);
  if (![8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000].includes(source.sampleRate)) {
    fail('UNSUPPORTED', 'MP3 input sample rate must be 8, 11.025, 12, 16, 22.05, 24, 32, 44.1 or 48 kHz.');
  }
  const highRate = source.sampleRate >= 32000;
  const bitrate = options.bitrate ?? (highRate ? 192000 : 128000);
  const allowed = highRate ? [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  if (!allowed.includes(bitrate / 1000)) fail('INVALID_ARGUMENT', `Unsupported MP3 bitrate for this sample rate: ${bitrate}.`);
  const limit = options.maxOutputBytes ?? 256 * 1024 * 1024;
  positive(limit, 'maxOutputBytes', true);
  if (onProgress !== undefined && typeof onProgress !== 'function') fail('INVALID_ARGUMENT', 'onProgress must be a function.');
  if (typeof Worker === 'undefined') fail('UNSUPPORTED', 'MP3 export requires Web Workers.');

  let url: string | undefined, worker: Worker | undefined;
  let pending: { resolve: (chunks: Uint8Array<ArrayBuffer>[]) => void; reject: (error: unknown) => void } | undefined;
  let failure: MediaError | undefined;
  const stop = (error: MediaError) => {
    failure ??= error;
    worker?.terminate();
    pending?.reject(failure);
    pending = undefined;
  };
  const abort = () => stop(new MediaError('ABORTED', 'MP3 export was cancelled.'));
  try {
    url = URL.createObjectURL(new Blob([mp3WorkerSource], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = ({ data }) => {
      if (data.error) {
        stop(new MediaError(data.code === 'INVALID_ARGUMENT' ? 'INVALID_ARGUMENT' : 'ENCODE_FAILED', data.error));
      } else {
        pending?.resolve(data.chunks);
        pending = undefined;
      }
    };
    worker.onerror = event => { event.preventDefault(); stop(new MediaError('ENCODE_FAILED', event.message || 'MP3 worker failed. Check worker-src CSP.')); };
    worker.onmessageerror = () => stop(new MediaError('ENCODE_FAILED', 'Could not read MP3 worker output.'));
    signal?.addEventListener('abort', abort, { once: true });
    const request = (message: unknown, transfer: Transferable[] = []) => new Promise<Uint8Array<ArrayBuffer>[]>((resolve, reject) => {
      checkAbort(signal);
      if (failure) throw failure;
      pending = { resolve, reject };
      worker!.postMessage(message, transfer);
    });
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    const append = (chunks: Uint8Array<ArrayBuffer>[]) => {
      for (const chunk of chunks) {
        size += chunk.byteLength;
        if (size > limit) fail('RESOURCE_LIMIT', 'MP3 exceeds maxOutputBytes.');
        parts.push(chunk);
      }
    };
    onProgress?.(0);
    await request({ type: 'init', sampleRate: source.sampleRate, channels: source.channels, bitrate });
    // Bound transfer memory; only one block is in flight and the application keeps its PCM.
    const blockSize = 1152 * 32;
    for (let offset = 0; offset < source.length; offset += blockSize) {
      checkAbort(signal);
      const count = Math.min(blockSize, source.length - offset), channels = source.read(offset, count);
      append(await request({ type: 'encode', channels }, channels.map(c => c.buffer)));
      checkAbort(signal);
      onProgress?.(0.99 * (offset + count) / source.length);
    }
    append(await request({ type: 'finish' }));
    checkAbort(signal);
    if (!size) fail('ENCODE_FAILED', 'MP3 encoder returned no data.');
    const blob = new Blob(parts, { type: 'audio/mpeg' });
    onProgress?.(1);
    checkAbort(signal);
    return blob;
  } catch (error) {
    throw mediaError(error, 'ENCODE_FAILED');
  } finally {
    signal?.removeEventListener('abort', abort);
    worker?.terminate();
    if (url) URL.revokeObjectURL(url);
  }
}
