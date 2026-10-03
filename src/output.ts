import { Output, Mp4OutputFormat, StreamTarget, VideoSample, VideoSampleSource, AudioSample, AudioSampleSource } from 'mediabunny';
import { getCapabilities } from './capabilities.js';
import { abortable, checkAbort, fail, mediaError, MediaError, positive } from './errors.js';
import { frameRateValue, frameTime, frameTiming, type FrameRate } from './time.js';
import { aacPrimingSamples } from './aac-state.js';
import { validatePcm, type PcmAudio } from './pcm.js';

export interface PositionedWrite { type: 'write'; data: Uint8Array<ArrayBuffer>; position: number }
export type Mp4Target = { kind: 'blob'; maxBytes?: number } | { kind: 'stream'; stream: WritableStream<PositionedWrite> };
export interface AudioOutputOptions { sampleRate: number; channels: number; codec?: 'aac' | 'opus'; bitrate?: number }
export interface ExportProgress {
  stage: 'encoding' | 'finalizing' | 'complete'; videoFrames: number; audioSamples: number;
  /** null when expectedFrames was not provided. Reaches 1 only after successful finalization. */
  fraction: number | null;
}
export interface WriterOptions {
  width: number; height: number; fps: FrameRate; videoBitrate?: number;
  audio?: AudioOutputOptions; target?: Mp4Target; expectedFrames?: number;
  signal?: AbortSignal; onProgress?: (progress: ExportProgress) => void;
}
export interface Mp4Result {
  blob: Blob | null; bytes: number; videoFrames: number; audioSamples: number;
  duration: number; width: number; height: number; fps: number;
  videoCodec: 'h264'; audioCodec: 'aac' | 'opus' | null;
}

// Fixed-size pages support MP4's positioned writes without a growing contiguous ArrayBuffer.
class PagedBytes {
  readonly pageSize = 1024 * 1024;
  readonly pages: Uint8Array<ArrayBuffer>[] = [];
  size = 0;
  constructor(readonly limit: number) {}
  write({ data, position }: PositionedWrite) {
    const end = position + data.byteLength;
    if (end > this.limit) fail('RESOURCE_LIMIT', 'MP4 exceeds the Blob byte limit; use a stream target or raise maxBytes.');
    for (let offset = 0; offset < data.length;) {
      const at = position + offset, page = Math.floor(at / this.pageSize), within = at % this.pageSize;
      this.pages[page] ??= new Uint8Array(Math.min(this.pageSize, this.limit - page * this.pageSize));
      const length = Math.min(data.length - offset, this.pages[page].length - within);
      this.pages[page].set(data.subarray(offset, offset + length), within);
      offset += length;
    }
    this.size = Math.max(this.size, end);
  }
  blob() {
    const parts = Array.from({ length: Math.ceil(this.size / this.pageSize) }, (_, i) => {
      const length = Math.min(this.pageSize, this.size - i * this.pageSize);
      return (this.pages[i] ?? new Uint8Array(length)).subarray(0, length);
    });
    const result = new Blob(parts, { type: 'video/mp4' });
    this.pages.length = 0;
    return result;
  }
  clear() { this.pages.length = 0; }
}

/** One video track plus optional audio. Await each operation; inputs remain caller-owned. */
export class Mp4Writer {
  #output: Output;
  #video: VideoSampleSource;
  #audio?: AudioSampleSource;
  #store?: PagedBytes;
  #destination?: WritableStreamDefaultWriter<PositionedWrite>;
  #destinationEnded = false;
  #state: 'open' | 'finalizing' | 'finished' | 'cancelled' | 'failed' = 'open';
  #cancelPromise?: Promise<void>;
  #pendingBackend?: Promise<void>;
  #busy = false;
  #videoFrames = 0;
  #audioSamples = 0;
  #audioPriming = 0;
  #bytes = 0;
  #onAbort = () => { void this.cancel().catch(() => {}); };
  #snapshot: WriterOptions;
  /** @internal Use createMp4Writer(). */
  constructor(options: WriterOptions) {
    // Caller mutation must not change the timeline or configured codec midway through an export.
    this.#snapshot = { ...options, fps: typeof options.fps === 'number' ? options.fps : { ...options.fps }, audio: options.audio && { ...options.audio } };
    const target = options.target ?? { kind: 'blob' };
    if (target.kind === 'blob') this.#store = new PagedBytes(target.maxBytes ?? 256 * 1024 * 1024);
    else this.#destination = target.stream.getWriter();
    const stream = new WritableStream<PositionedWrite>({
      write: async command => {
        if (this.#state === 'cancelled' || this.#state === 'failed') fail('ABORTED', 'The output has been stopped.');
        if (this.#store) this.#store.write(command);
        else await this.#destination!.write(command);
        this.#bytes = Math.max(this.#bytes, command.position + command.data.length);
      },
      close: () => this.#endDestination(this.#state !== 'finalizing'),
      abort: () => this.#endDestination(true),
    });
    this.#output = new Output({ format: new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(stream, { chunked: true, chunkSize: 1024 * 1024 }) });
    this.#video = new VideoSampleSource({ codec: 'avc', bitrate: options.videoBitrate ?? 8_000_000, latencyMode: 'quality' });
    this.#output.addVideoTrack(this.#video, { frameRate: frameRateValue(options.fps) });
    if (options.audio) {
      this.#audioPriming = (options.audio.codec ?? 'aac') === 'aac' ? aacPrimingSamples() : 0;
      this.#audio = new AudioSampleSource({ codec: options.audio.codec ?? 'aac', bitrate: options.audio.bitrate ?? 192_000 });
      this.#output.addAudioTrack(this.#audio);
    }
    options.signal?.addEventListener('abort', this.#onAbort, { once: true });
  }
  get state() { return this.#state; }
  get videoFrames() { return this.#videoFrames; }
  get audioSamples() { return this.#audioSamples; }
  #check() {
    checkAbort(this.#snapshot.signal);
    if (this.#state === 'cancelled') fail('ABORTED', 'The writer was cancelled.');
    if (this.#state !== 'open') fail('CLOSED', `The writer is ${this.#state}.`);
  }
  #progress(stage: ExportProgress['stage']) {
    const total = this.#snapshot.expectedFrames;
    this.#snapshot.onProgress?.({ stage, videoFrames: this.#videoFrames, audioSamples: this.#audioSamples,
      fraction: stage === 'complete' ? 1 : total ? Math.min(0.99, this.#videoFrames / total * 0.99) : null });
  }
  async #endDestination(abort: boolean) {
    if (!this.#destination || this.#destinationEnded) return;
    this.#destinationEnded = true;
    try {
      if (abort) await this.#destination.abort(new MediaError('ABORTED', 'MP4 output did not complete.'));
      else await this.#destination.close();
    } finally { this.#destination.releaseLock(); }
  }
  async #run<T>(operation: () => Promise<T>): Promise<T> {
    this.#check();
    if (this.#busy) fail('BUSY', 'Await the previous writer operation before submitting more data.');
    this.#busy = true;
    try { return await operation(); }
    catch (error) {
      const aborted = this.#snapshot.signal?.aborted || this.#state === 'cancelled';
      await this.#stop(aborted ? 'cancelled' : 'failed');
      if (aborted) fail('ABORTED', 'The export was cancelled.');
      throw mediaError(error, 'ENCODE_FAILED');
    } finally { this.#busy = false; }
  }
  async #backend(operation: Promise<void>): Promise<void> {
    this.#pendingBackend = operation;
    try { await operation; }
    finally { if (this.#pendingBackend === operation) this.#pendingBackend = undefined; }
  }
  async #stop(state: 'cancelled' | 'failed') {
    if (this.#state === 'finished') return;
    if (this.#cancelPromise) return this.#cancelPromise;
    this.#state = state;
    this.#snapshot.signal?.removeEventListener('abort', this.#onAbort);
    const pending = this.#pendingBackend;
    this.#cancelPromise = (async () => {
      // The AAC extension terminates its worker on close without settling an in-flight init.
      // Stop accepting data immediately, but let that operation settle before tearing it down.
      // This also avoids closing a native encoder while a producer is awaiting its queue.
      try { await pending; } catch { /* Preserve the original failure. */ }
      try { await this.#output.cancel(); } catch { /* Preserve the original failure. */ }
      try { await this.#endDestination(true); } catch { /* Preserve the original failure. */ }
      finally { this.#store?.clear(); }
    })();
    return this.#cancelPromise;
  }
  /** @internal */
  async initialize() {
    await this.#run(async () => { await this.#backend(this.#output.start()); this.#check(); });
    return this;
  }
  async addVideoFrame(source: CanvasImageSource): Promise<void> {
    return this.#run(async () => {
      const o = this.#snapshot;
      if (o.expectedFrames !== undefined && this.#videoFrames >= o.expectedFrames) fail('INVALID_ARGUMENT', 'More frames than expectedFrames.');
      const sample = new VideoSample(typeof VideoFrame !== 'undefined' && source instanceof VideoFrame ? source.clone() : source,
        frameTiming(this.#videoFrames, o.fps));
      try {
        if (sample.displayWidth !== o.width || sample.displayHeight !== o.height) fail('INVALID_ARGUMENT', 'Frame dimensions must match the output dimensions.');
        await this.#backend(this.#video.add(sample, { keyFrame: this.#videoFrames % Math.max(1, Math.round(frameRateValue(o.fps) * 2)) === 0 }));
        this.#check(); this.#videoFrames++; this.#progress('encoding');
      } finally { sample.close(); }
    });
  }
  /** Window adapter. Input is borrowed until this Promise settles. */
  async addAudio(buffer: AudioBuffer): Promise<void> {
    return this.#run(async () => {
      if (typeof AudioBuffer === 'undefined' || !(buffer instanceof AudioBuffer)) {
        fail('INVALID_ARGUMENT', 'Expected AudioBuffer; use addPcm() in Workers.');
      }
      await this.#appendPcm({ sampleRate: buffer.sampleRate, numberOfChannels: buffer.numberOfChannels,
        length: buffer.length, channelData: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)) });
    });
  }
  /** Append planar PCM contiguously. Timestamp placement is the application's responsibility. */
  async addPcm(pcm: PcmAudio): Promise<void> {
    return this.#run(() => this.#appendPcm(pcm));
  }
  async #appendPcm(buffer: PcmAudio) {
    validatePcm(buffer);
    const config = this.#snapshot.audio;
    if (!config || !this.#audio) fail('INVALID_ARGUMENT', 'This writer has no audio track.');
    if (buffer.sampleRate !== config.sampleRate || buffer.numberOfChannels !== config.channels) {
      fail('INVALID_ARGUMENT', 'PCM sample rate and channel count must match the output audio configuration.');
    }
    for (let offset = 0; offset < buffer.length; offset += 4096) {
      this.#check();
      const length = Math.min(4096, buffer.length - offset);
      const pcm = new Float32Array(length * config.channels);
      for (let c = 0; c < config.channels; c++) {
        const values = buffer.channelData[c].subarray(offset, offset + length);
        if (values.some(value => !Number.isFinite(value))) fail('INVALID_ARGUMENT', 'PCM samples must be finite.');
        pcm.set(values, c * length);
      }
      const sample = new AudioSample({ data: pcm, format: 'f32-planar', sampleRate: config.sampleRate,
        numberOfChannels: config.channels, timestamp: (this.#audioSamples - this.#audioPriming) / config.sampleRate });
      try { await this.#backend(this.#audio.add(sample)); this.#check(); this.#audioSamples += length; }
      finally { sample.close(); }
    }
    this.#progress('encoding');
  }
  async finish(): Promise<Mp4Result> {
    return this.#run(async () => {
      const o = this.#snapshot, duration = frameTime(this.#videoFrames, o.fps);
      if (!this.#videoFrames) fail('INVALID_ARGUMENT', 'At least one video frame is required.');
      if (o.expectedFrames !== undefined && this.#videoFrames !== o.expectedFrames) fail('INVALID_ARGUMENT', 'Video frame count does not match expectedFrames.');
      if (o.audio && (!this.#audioSamples || Math.abs(this.#audioSamples / o.audio.sampleRate - duration) > 1 / frameRateValue(o.fps) + 1 / o.audio.sampleRate)) {
        fail('INVALID_ARGUMENT', 'Audio and video durations must agree within one video frame.');
      }
      this.#progress('finalizing');
      this.#check(); this.#state = 'finalizing';
      await this.#backend(this.#output.finalize());
      checkAbort(o.signal);
      if (this.#state !== 'finalizing') fail('ABORTED', 'The writer was cancelled during finalization.');
      this.#state = 'finished';
      o.signal?.removeEventListener('abort', this.#onAbort);
      const result: Mp4Result = { blob: this.#store?.blob() ?? null, bytes: this.#bytes, videoFrames: this.#videoFrames,
        audioSamples: this.#audioSamples, duration, width: o.width, height: o.height, fps: frameRateValue(o.fps),
        videoCodec: 'h264', audioCodec: o.audio ? o.audio.codec ?? 'aac' : null };
      this.#progress('complete');
      return result;
    });
  }
  async cancel(): Promise<void> { await this.#stop('cancelled'); }
}

export async function createMp4Writer(options: WriterOptions): Promise<Mp4Writer> {
  checkAbort(options.signal);
  positive(options.width, 'width', true); positive(options.height, 'height', true);
  if (options.width % 2 || options.height % 2) fail('INVALID_ARGUMENT', 'H.264 output dimensions must be even.');
  positive(options.videoBitrate ?? 8_000_000, 'videoBitrate', true);
  if (frameRateValue(options.fps) < 1 || frameRateValue(options.fps) > 240) fail('INVALID_ARGUMENT', 'Output fps must be between 1 and 240.');
  if (options.expectedFrames !== undefined) positive(options.expectedFrames, 'expectedFrames', true);
  if (options.target?.kind === 'blob') positive(options.target.maxBytes ?? 256 * 1024 * 1024, 'maxBytes', true);
  if (options.target?.kind === 'stream' && options.target.stream.locked) fail('INVALID_ARGUMENT', 'The destination stream is already locked.');
  if (options.audio) {
    positive(options.audio.sampleRate, 'audio.sampleRate', true); positive(options.audio.channels, 'audio.channels', true);
    positive(options.audio.bitrate ?? 192_000, 'audio.bitrate', true);
    if (options.audio.codec !== undefined && !['aac', 'opus'].includes(options.audio.codec)) fail('INVALID_ARGUMENT', 'Unsupported output audio codec.');
  }
  const support = await getCapabilities({ width: options.width, height: options.height, fps: options.fps, videoBitrate: options.videoBitrate,
    sampleRate: options.audio?.sampleRate, channels: options.audio?.channels, audioBitrate: options.audio?.bitrate });
  checkAbort(options.signal);
  if (!support.h264Encode) fail('UNSUPPORTED', 'H.264 encoding is unavailable for this configuration.');
  if (options.audio && !(options.audio.codec === 'opus' ? support.opusEncode : support.aacEncode)) {
    fail('UNSUPPORTED', options.audio.codec === 'opus' ? 'Opus encoding is unavailable.' : 'AAC encoding is unavailable. Enable the optional AAC fallback or explicitly select another supported codec.');
  }
  return new Mp4Writer(options).initialize();
}

export interface RenderOptions extends Omit<WriterOptions, 'audio' | 'expectedFrames'> {
  duration: number;
  renderFrame: (context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, time: number, frameIndex: number) => void | Promise<void>;
  audio?: AudioBuffer;
  audioCodec?: 'aac' | 'opus'; audioBitrate?: number;
}
/** Canvas rendering with a shared absolute frame clock. Audio starts at zero and is clipped/padded to the output. */
export async function renderMp4(options: RenderOptions): Promise<Mp4Result> {
  positive(options.duration, 'duration');
  const fps = frameRateValue(options.fps), count = Math.ceil(options.duration * fps - 1e-9);
  positive(count, 'frame count', true);
  const writer = await createMp4Writer({ ...options, expectedFrames: count,
    audio: options.audio ? { sampleRate: options.audio.sampleRate, channels: options.audio.numberOfChannels,
      codec: options.audioCodec ?? 'aac', bitrate: options.audioBitrate } : undefined });
  try {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(options.width, options.height) : document.createElement('canvas');
    canvas.width = options.width; canvas.height = options.height;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) fail('UNSUPPORTED', 'A 2D canvas context is required.');
    for (let n = 0; n < count; n++) {
      checkAbort(options.signal);
      context.reset();
      await abortable(Promise.resolve(options.renderFrame(context, frameTime(n, options.fps), n)), options.signal);
      checkAbort(options.signal);
      await writer.addVideoFrame(canvas);
      if (options.audio) {
        const audio = options.audio;
        const until = Math.round(frameTime(n + 1, options.fps) * audio.sampleRate);
        const start = writer.audioSamples, length = until - start;
        if (length > 0) {
          const block = new AudioBuffer({ length, sampleRate: audio.sampleRate, numberOfChannels: audio.numberOfChannels });
          for (let c = 0; c < audio.numberOfChannels; c++) {
            if (start < audio.length) block.copyToChannel(audio.getChannelData(c).subarray(start, Math.min(until, audio.length)), c);
          }
          await writer.addAudio(block);
        }
      }
      if (n % 8 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    return await writer.finish();
  } catch (error) { await writer.cancel(); throw mediaError(error, 'ENCODE_FAILED'); }
}
