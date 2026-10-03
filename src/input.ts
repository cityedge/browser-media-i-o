import {
  Input, BlobSource, MP4, MP3, WAVE, EncodedPacketSink, VideoSampleSink, AudioSampleSink,
  type InputTrack, type InputVideoTrack, type InputAudioTrack, type VideoSample,
} from 'mediabunny';
import { abortable, checkAbort, fail, mediaError, MediaError, nonnegative, positive } from './errors.js';

import { decoderSession } from './decoder-session.js';
import { reader, ReadScope, type MediaReader } from './reader.js';
import type { PcmBlock } from './pcm.js';

export interface ReadOptions { trackId?: number; signal?: AbortSignal }
export interface RangeReadOptions extends ReadOptions { start?: number; end?: number }
export interface AudioReadOptions extends RangeReadOptions { maxBlockSamples?: number }
export interface RequestedVideoFrame { time: number; frame: MediaFrame | null }

function micros(time: number) {
  const value = Math.round(time * 1e6);
  if (!Number.isSafeInteger(value)) fail('INVALID_ARGUMENT', 'Timestamp exceeds microsecond precision.');
  return value;
}
function interval(sample: VideoSample) {
  return [micros(sample.timestamp), micros(sample.timestamp + sample.duration)] as const;
}
function range(options: RangeReadOptions) {
  const start = options.start ?? 0, end = options.end ?? Infinity;
  nonnegative(start, 'start');
  if (!(end > start) || (end !== Infinity && !Number.isFinite(end))) fail('INVALID_ARGUMENT', 'end must be greater than start.');
  return { start, end };
}

export interface OpenOptions {
  signal?: AbortSignal;
  readCacheBytes?: number;
  /** Limits live frame handles returned by this input; callers must close them. Default: 8. */
  maxOutstandingFrames?: number;
}
export interface DurationInfo { seconds: number | null; source: 'metadata' | 'packets' }
export interface TrackInfo {
  id: number; kind: 'video' | 'audio' | 'subtitle'; codec: string | null; canDecode: boolean;
  metadataDuration: number | null; duration: DurationInfo; startTime: number | null;
  packetCount: number | null;
  video?: { width: number; height: number; rotation: number; averageFrameRate: number | null; cadence: 'constant' | 'variable' | 'unknown' };
  audio?: { sampleRate: number; channels: number };
}
export interface MediaInfo { mimeType: string; size: number; duration: DurationInfo; tracks: TrackInfo[] }
export interface ProbeOptions extends OpenOptions {
  mode?: 'metadata' | 'scan';
  onProgress?: (progress: { trackId: number; packets: number }) => void;
}

/** Owns a decoded frame. close() is idempotent; closing its input also closes this handle. */
export class MediaFrame {
  #sample: VideoSample | null;
  readonly timestamp: number;
  readonly duration: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly flip: boolean;
  readonly squarePixelWidth: number;
  readonly squarePixelHeight: number;
  /** @internal */
  constructor(sample: VideoSample, private release: () => void) {
    this.#sample = sample;
    this.timestamp = sample.timestamp; this.duration = sample.duration;
    this.width = sample.displayWidth; this.height = sample.displayHeight; this.rotation = sample.rotation;
    this.flip = sample.flip; this.squarePixelWidth = sample.squarePixelWidth; this.squarePixelHeight = sample.squarePixelHeight;
  }
  get closed() { return this.#sample === null; }
  draw(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x = 0, y = 0, width = this.width, height = this.height) {
    if (!this.#sample) fail('CLOSED', 'The frame has been closed.');
    this.#sample.draw(context, x, y, width, height);
  }
  /** Returns a separate native frame owned by the caller. Rotation metadata remains on this handle. */
  toVideoFrame(): VideoFrame {
    if (!this.#sample) fail('CLOSED', 'The frame has been closed.');
    return this.#sample.toVideoFrame();
  }
  close() { if (this.#sample) { this.#sample.close(); this.#sample = null; this.release(); } }
}

export class MediaInput {
  #input: Input;
  #frames = new Set<MediaFrame>();
  #active?: ReadScope;
  #closed = false;
  #onAbort = () => this.close();
  /** @internal Use openMedia(). */
  constructor(private readonly blob: Blob, private readonly options: OpenOptions = {}) {
    this.options = { ...options };
    if (!(blob instanceof Blob) || blob.size === 0) fail('INVALID_ARGUMENT', 'A non-empty File or Blob is required.');
    positive(options.readCacheBytes ?? 8 * 1024 * 1024, 'readCacheBytes', true);
    positive(options.maxOutstandingFrames ?? 8, 'maxOutstandingFrames', true);
    checkAbort(options.signal);
    this.#input = new Input({ source: new BlobSource(blob, { maxCacheSize: options.readCacheBytes }), formats: [MP4, MP3, WAVE] });
    options.signal?.addEventListener('abort', this.#onAbort, { once: true });
  }
  get closed() { return this.#closed; }
  #check() { checkAbort(this.options.signal); if (this.#closed) fail('CLOSED', 'The media input has been closed.'); }
  #acquire(scope: ReadScope) {
    this.#check();
    if (this.#active) fail('BUSY', 'Await completion of the current read or its return() before starting another read.');
    this.#active = scope;
    return () => { if (this.#active === scope) this.#active = undefined; };
  }
  async #operation<T>(action: (scope: ReadScope) => Promise<T>, signal?: AbortSignal): Promise<T> {
    checkAbort(signal);
    const scope = new ReadScope(), release = this.#acquire(scope);
    const abort = () => scope.stop(new MediaError('ABORTED', 'The read was cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try { scope.check(); const result = await action(scope); scope.check(); this.#check(); return result; }
    catch (error) { if (scope.error) throw scope.error; throw mediaError(error, 'DECODE_FAILED'); }
    finally { try { scope.stop(); await scope.detach(); } finally { signal?.removeEventListener('abort', abort); release(); } }
  }
  /** @internal */
  async initialize() {
    try {
      if (!(await this.#input.canRead())) fail('UNSUPPORTED', 'Supported input containers are MP4/M4A, MP3 and WAV.');
      this.#check(); return this;
    } catch (error) { this.close(); checkAbort(this.options.signal); throw mediaError(error, 'UNSUPPORTED'); }
  }
  async probe(options: Pick<ProbeOptions, 'mode' | 'onProgress' | 'signal'> = {}): Promise<MediaInfo> {
    return this.#operation(async scope => {
      const mode = options.mode ?? 'scan';
      if (mode !== 'metadata' && mode !== 'scan') fail('INVALID_ARGUMENT', 'Unknown probe mode.');
      const tracks: TrackInfo[] = [];
      for (const track of await this.#input.getTracks()) {
        scope.check();
        const metadataDuration = await track.getDurationFromMetadata();
        const info: TrackInfo = {
          id: track.id, kind: track.type, codec: await track.getCodec(), canDecode: await track.canDecode(),
          metadataDuration, duration: { seconds: metadataDuration, source: 'metadata' },
          startTime: null, packetCount: null,
        };
        let uniformDuration: number | null = null;
        let variable = false;
        if (mode === 'scan') {
          let count = 0, start = Infinity, end = -Infinity;
          const sink = new EncodedPacketSink(track);
          for (let packet = await sink.getFirstPacket({ metadataOnly: true }); packet; packet = await sink.getNextPacket(packet, { metadataOnly: true })) {
            scope.check();
            count++; start = Math.min(start, packet.timestamp); end = Math.max(end, packet.timestamp + packet.duration);
            if (uniformDuration === null) uniformDuration = packet.duration;
            else if (Math.abs(uniformDuration - packet.duration) > 0.000002) variable = true;
            if (count % 128 === 0) {
              options.onProgress?.({ trackId: track.id, packets: count });
              await new Promise<void>(resolve => setTimeout(resolve, 0));
            }
          }
          info.packetCount = count;
          info.startTime = count ? start : null;
          info.duration = { seconds: count ? Math.max(0, end) : null, source: 'packets' };
          options.onProgress?.({ trackId: track.id, packets: count });
        }
        if (track.isVideoTrack()) {
          const span = info.duration.seconds !== null && info.startTime !== null ? info.duration.seconds - info.startTime : 0;
          info.video = {
            width: await track.getDisplayWidth(), height: await track.getDisplayHeight(), rotation: await track.getRotation(),
            averageFrameRate: span > 0 && info.packetCount ? info.packetCount / span : null,
            cadence: mode === 'scan' && (info.packetCount ?? 0) > 1 && uniformDuration && uniformDuration > 0 ? (variable ? 'variable' : 'constant') : 'unknown',
          };
        }
        if (track.isAudioTrack()) info.audio = { sampleRate: await track.getSampleRate(), channels: await track.getNumberOfChannels() };
        tracks.push(info);
      }
      const durations = tracks.map(t => t.duration.seconds);
      return { mimeType: await this.#input.getMimeType(), size: this.blob.size, tracks,
        duration: { seconds: durations.length && durations.every(d => d !== null) ? Math.max(...durations as number[]) : null, source: mode === 'scan' ? 'packets' : 'metadata' } };
    }, options.signal);
  }
  async #track(kind: 'video', id?: number): Promise<InputVideoTrack>;
  async #track(kind: 'audio', id?: number): Promise<InputAudioTrack>;
  async #track(kind: 'video' | 'audio', id?: number): Promise<InputTrack> {
    const track = id === undefined
      ? await (kind === 'video' ? this.#input.getPrimaryVideoTrack() : this.#input.getPrimaryAudioTrack())
      : (await this.#input.getTracks()).find(t => t.id === id && t.type === kind);
    if (!track) fail('INVALID_ARGUMENT', `No ${kind} track matches the request.`);
    if (!(await track.canDecode())) fail('UNSUPPORTED', `The ${kind} track cannot be decoded by this browser.`);
    return track;
  }
  #wrap(sample: VideoSample): MediaFrame {
    if (this.#frames.size >= (this.options.maxOutstandingFrames ?? 8)) {
      sample.close(); fail('RESOURCE_LIMIT', 'Close outstanding frames before requesting more.');
    }
    const frame = new MediaFrame(sample, () => this.#frames.delete(frame));
    this.#frames.add(frame); return frame;
  }
  #read<T>(signal: AbortSignal | undefined, generate: (scope: ReadScope) => AsyncGenerator<T, void, unknown>, discard: (value: T) => void) {
    return reader({ signal, acquire: scope => this.#acquire(scope), generate, discard, cleanupFailed: () => this.close() });
  }
  async *#samples(start: number, end: number, options: ReadOptions, scope: ReadScope): AsyncGenerator<VideoSample> {
    const track = await this.#track('video', options.trackId); scope.check();
    const sink = new VideoSampleSink(track);
    // Start just below the rounded timestamp so native microsecond rounding cannot skip its frame.
    const session = decoderSession<VideoSample>(sink, () => sink.samples(start - 0.0000005, end));
    scope.attach(() => session.close());
    try {
      while (!scope.stopped) {
        const item = await session.iterator.next();
        if (item.done) break;
        if (scope.stopped) { item.value.close(); break; }
        // The backend retains its final pre-start sample even after yielding it.
        // Keep our handle independent of backend return()/closeSamples().
        const owned = item.value.clone(); item.value.close();
        yield owned;
      }
      if (scope.error) throw scope.error;
    } finally { await scope.detach(); }
  }
  /** Original frames whose half-open presentation intervals overlap [start,end). */
  videoFrames(options: RangeReadOptions = {}): MediaReader<MediaFrame> {
    const self = this;
    return this.#read(options.signal, async function* (scope) {
      const { start, end } = range(options), from = micros(start), until = end === Infinity ? Infinity : micros(end);
      for await (const sample of self.#samples(from / 1e6, end, options, scope)) {
        const [a, b] = interval(sample);
        if (a < until && b > from && b > a) yield self.#wrap(sample);
        else sample.close();
      }
    }, frame => frame.close());
  }
  /** Monotone, lazy requested times. Each returned frame has independent ownership. */
  videoFramesAt(times: Iterable<number>, options: ReadOptions = {}): MediaReader<RequestedVideoFrame> {
    const self = this;
    return this.#read(options.signal, async function* (scope) {
      if (!times || typeof times[Symbol.iterator] !== 'function') fail('INVALID_ARGUMENT', 'times must be a synchronous iterable.');
      let previous = -Infinity, current: VideoSample | undefined, lookahead: VideoSample | undefined;
      let samples: AsyncGenerator<VideoSample> | undefined, ended = false;
      try {
        for (const time of times) {
          scope.check(); nonnegative(time, 'time');
          if (time < previous) fail('INVALID_ARGUMENT', 'Requested times must be nondecreasing.');
          const t = micros(time);
          // Sparse forward jumps seek anew; ordinary frame-clock traversal reuses the decoder.
          if (!samples || time - previous > 1) {
            await samples?.return(undefined); current?.close(); lookahead?.close();
            current = lookahead = undefined; ended = false;
            samples = self.#samples(t / 1e6, Infinity, options, scope);
          }
          previous = time;
          while (!ended) {
            if (!lookahead) {
              const item = await samples.next();
              if (item.done) { ended = true; break; }
              lookahead = item.value;
            }
            if (micros(lookahead.timestamp) > t) break;
            current?.close(); current = lookahead; lookahead = undefined;
          }
          scope.check();
          const bounds = current && interval(current);
          const frame = current && bounds && bounds[0] <= t && t < bounds[1] ? self.#wrap(current.clone()) : null;
          yield { time, frame };
        }
      } finally { current?.close(); lookahead?.close(); await samples?.return(undefined); }
    }, item => item.frame?.close());
  }
  /** Returns the displayed frame at t, or null outside its presentation interval. */
  async getVideoFrame(time: number, options: ReadOptions = {}): Promise<MediaFrame | null> {
    const frames = this.videoFramesAt([time], options);
    let frame: MediaFrame | null = null;
    try {
      const item = await frames.next(); frame = item.done ? null : item.value.frame;
      await frames.return();
      checkAbort(options.signal); this.#check(); return frame;
    } catch (error) { frame?.close(); throw error; }
    finally { await frames.return(); }
  }
  /** Caller-owned planar PCM, clipped at sample boundaries, with original timestamps. */
  audioPcmBlocks(options: AudioReadOptions = {}): MediaReader<PcmBlock> {
    const self = this;
    return this.#read(options.signal, async function* (scope) {
      const { start, end } = range(options), max = options.maxBlockSamples ?? 4096;
      positive(max, 'maxBlockSamples', true);
      if (max > 65536) fail('INVALID_ARGUMENT', 'maxBlockSamples must not exceed 65536.');
      const track = await self.#track('audio', options.trackId); scope.check();
      const sink = new AudioSampleSink(track);
      const session = decoderSession(sink, () => sink.samples(start, end));
      scope.attach(() => session.close());
      try {
        while (!scope.stopped) {
          const item = await session.iterator.next();
          if (item.done) break;
          const sample = item.value;
          try {
            scope.check();
            const sr = sample.sampleRate;
            const from = Math.max(0, Math.ceil((start - sample.timestamp) * sr - 1e-6));
            const to = Math.min(sample.numberOfFrames, Math.ceil((end - sample.timestamp) * sr - 1e-6));
            for (let at = from; at < to; at += max) {
              scope.check();
              const length = Math.min(max, to - at);
              const channelData = Array.from({ length: sample.numberOfChannels }, (_, planeIndex) => {
                const data = new Float32Array(length);
                sample.copyTo(data, { planeIndex, format: 'f32-planar', frameOffset: at, frameCount: length });
                return data;
              });
              const timestamp = sample.timestamp + at / sr;
              if (at + length === to) sample.close();
              yield { timestamp, sampleRate: sr, numberOfChannels: channelData.length, length, channelData };
            }
          } finally { sample.close(); }
        }
        if (scope.error) throw scope.error;
      } finally { await scope.detach(); }
    }, () => {});
  }
  /** Window convenience adapter; the PCM reader itself works in Dedicated Workers. */
  audioBlocks(options: AudioReadOptions = {}): MediaReader<{ timestamp: number; buffer: AudioBuffer }> {
    const source = this.audioPcmBlocks(options);
    return {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        if (typeof AudioBuffer === 'undefined') { await source.return(); fail('UNSUPPORTED', 'Use audioPcmBlocks() in Workers.'); }
        const item = await source.next();
        if (item.done) return { done: true, value: undefined };
        try {
          const pcm = item.value;
          const buffer = new AudioBuffer({ length: pcm.length, sampleRate: pcm.sampleRate, numberOfChannels: pcm.numberOfChannels });
          pcm.channelData.forEach((data, c) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, c));
          return { done: false, value: { timestamp: pcm.timestamp, buffer } };
        } catch (error) { await source.return(); throw error; }
      },
      async return() { await source.return(); return { done: true, value: undefined }; },
    };
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.options.signal?.removeEventListener('abort', this.#onAbort);
    for (const frame of this.#frames) frame.close();
    this.#active?.stop(new MediaError(this.options.signal?.aborted ? 'ABORTED' : 'CLOSED', 'The media input has been closed.'));
    this.#input.dispose();
  }
}

export async function openMedia(blob: Blob, options: OpenOptions = {}): Promise<MediaInput> {
  return new MediaInput(blob, options).initialize();
}
export async function probe(blob: Blob, options: ProbeOptions = {}): Promise<MediaInfo> {
  const input = await openMedia(blob, options);
  try { return await input.probe(options); } finally { input.close(); }
}

export interface DecodeAudioOptions {
  signal?: AbortSignal; sampleRate?: number; maxInputBytes?: number; maxDecodedBytes?: number;
}
/** Full-file Web Audio decode. Duration is derived from decoded PCM, never the container header. */
export async function decodeAudio(blob: Blob, options: DecodeAudioOptions = {}) {
  checkAbort(options.signal);
  if (!(blob instanceof Blob) || !blob.size) fail('INVALID_ARGUMENT', 'A non-empty File or Blob is required.');
  const { sampleRate = 48000, maxInputBytes = 128 * 1024 * 1024, maxDecodedBytes = 512 * 1024 * 1024 } = options;
  positive(sampleRate, 'sampleRate', true); positive(maxInputBytes, 'maxInputBytes', true); positive(maxDecodedBytes, 'maxDecodedBytes', true);
  if (blob.size > maxInputBytes) fail('RESOURCE_LIMIT', 'Compressed audio exceeds maxInputBytes; use audioBlocks for large media.');
  try {
    const context = new OfflineAudioContext(1, 1, sampleRate);
    const data = await abortable(blob.arrayBuffer(), options.signal);
    checkAbort(options.signal);
    const buffer = await abortable(context.decodeAudioData(data), options.signal);
    checkAbort(options.signal);
    if (buffer.length * buffer.numberOfChannels * 4 > maxDecodedBytes) fail('RESOURCE_LIMIT', 'Decoded PCM exceeds maxDecodedBytes.');
    return { buffer, sampleCount: buffer.length, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels,
      duration: buffer.length / buffer.sampleRate, durationSource: 'decoded-samples' as const };
  } catch (error) { checkAbort(options.signal); throw mediaError(error, 'DECODE_FAILED'); }
}
