import { Input, BlobSource, MP4, EncodedPacketSink, EncodedVideoPacketSource, Output, Mp4OutputFormat,
  StreamTarget, AudioSampleSource, AudioSample, canEncodeAudio, type InputVideoTrack, type EncodedPacket,
  type TransformationMatrix } from 'mediabunny';
import { abortable, checkAbort, fail, mediaError, positive } from './errors.js';
import { PagedBytes, type Mp4Target, type PositionedWrite } from './output.js';
import { validatePcm, type PcmAudio } from './pcm.js';
import { aacPrimingSamples } from './aac-state.js';
import { AvcCopyValidator } from './video-copy-avc.js';
import { inspectCopyContainer } from './video-copy-container.js';
import { copyFail, copyProofFail, type VideoCopyReason } from './video-copy-errors.js';
import { CopyWarnings, type VideoCopyValidation, type VideoCopyWarning, type VideoCopyDiagnosticCode } from './video-copy-diagnostics.js';
import { trimCopyMoov } from './video-copy-moov.js';
export { VideoCopyError, type VideoCopyReason } from './video-copy-errors.js';
export type { VideoCopyValidation, VideoCopyWarning, VideoCopyDiagnosticCode } from './video-copy-diagnostics.js';

export interface VideoCopyProgress {
  stage: 'inspecting' | 'copying' | 'finalizing' | 'complete';
  fraction: number | null; videoPackets: number; audioSamples: number;
}
export interface VideoCopyOperation { signal?: AbortSignal; onProgress?: (progress: VideoCopyProgress) => void }
export interface VideoCopyBoundary { readonly id: string; readonly time: number; readonly tick: number; readonly kind: 'idr' | 'sync' | 'eof' }
export interface VideoCopyInfo {
  readonly validation: VideoCopyValidation; readonly warnings: readonly VideoCopyWarning[];
  readonly supported: true; readonly videoTrackId: number; readonly codec: 'h264'; readonly timeResolution: number;
  readonly startTime: number; readonly endTime: number; readonly videoPackets: number;
  readonly width: number; readonly height: number; readonly displayWidth: number; readonly displayHeight: number;
  readonly rotation: number; readonly pixelAspectRatio: Readonly<{ num: number; den: number }>;
  readonly colorSpace: Readonly<VideoColorSpaceInit>; readonly transformationMatrix: readonly number[];
  readonly boundaries: readonly VideoCopyBoundary[];
  readonly keyframeInterval: Readonly<{ min: number; max: number; mean: number }>;
}
export interface VideoCopyRange {
  readonly omittedVideoPackets: number; readonly adjustedVideoPackets: number;
  readonly requestedStart: number; readonly requestedEnd: number;
  readonly sourceStart: number; readonly sourceEnd: number; readonly startAdjustment: number; readonly endAdjustment: number;
  readonly startBoundaryId: string; readonly endBoundaryId: string;
  readonly outputStart: number; readonly outputEnd: number;
  readonly audioStartSample: number | null; readonly audioEndSample: number | null; readonly audioSamples: number | null;
}
export interface VideoCopyPlan {
  readonly validation: VideoCopyValidation; readonly warnings: readonly VideoCopyWarning[];
  readonly omittedVideoPackets: number; readonly adjustedVideoPackets: number;
  readonly ranges: readonly VideoCopyRange[]; readonly duration: number;
  readonly audioSampleRate: number | null; readonly audioSamples: number | null; readonly videoPackets: number;
}
export interface VideoCopyPlanOptions extends VideoCopyOperation {
  keepRanges: readonly { start: number; end: number }[]; snap: 'strict' | 'inside'; audioSampleRate?: number;
}
export interface VideoCopyAudio {
  mode: 'pcm'; sampleRate: number; channels: number; codec?: 'aac'; bitrate: number;
  /** Produce bounded blocks. Borrowed until the next next() call. Non-cooperative next()/return() may delay cleanup. */
  blocks: (signal: AbortSignal) => AsyncIterable<PcmAudio>;
}
export interface VideoCopyExportOptions extends VideoCopyOperation {
  plan: VideoCopyPlan; audio?: VideoCopyAudio | { mode: 'none' }; target?: Mp4Target;
}
export interface VideoCopyResult {
  validation: VideoCopyValidation; warnings: readonly VideoCopyWarning[];
  omittedVideoPackets: number; adjustedVideoPackets: number;
  videoMode: 'copy'; plan: VideoCopyPlan; duration: number; blob: Blob | null; bytes: number;
  videoBytes: number; averageVideoBitrate: number; videoPackets: number; audioSamples: number;
  videoCodec: 'h264'; audioCodec: 'aac' | null;
  width: number; height: number; displayWidth: number; displayHeight: number; rotation: number;
}
type Record = { tick: number; duration: number; sequence: number; bytes: number; key: boolean };
type Boundary = VideoCopyBoundary & { index: number };
type Span = { from: number; until: number; sourceTick: number; sourceEndTick: number; outputTick: number; lastCopied: number; lastPresentation: number };
const freeze = <T extends object>(x: T): Readonly<T> => Object.freeze(x);
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const sampleAt = (tick: number, rate: number, scale: number) => Number((BigInt(tick) * BigInt(rate) * 2n + BigInt(scale)) / (2n * BigInt(scale)));
const rejectEncodingOptions = (options: object) => {
  for (const key of ['fps', 'width', 'height', 'videoBitrate', 'videoBitrateMode', 'videoQuantizer', 'videoHardwareAcceleration', 'renderFrame']) {
    if (key in options) copyFail('CONFLICTING_OPTIONS', `Video copy does not accept ${key}.`, 'INVALID_ARGUMENT');
  }
};

/** Input-bound, exclusive session using only public Mediabunny packet APIs. */
export class VideoCopySession {
  #input: Input; #track: InputVideoTrack; #file: Blob;
  #records: Record[] = []; #boundaries: Boundary[] = []; #info?: VideoCopyInfo;
  #config?: VideoDecoderConfig; #matrix?: TransformationMatrix;
  #plans = new WeakMap<VideoCopyPlan, Span[]>();
  #closing = false; #controller?: AbortController; #pending?: Promise<unknown>;
  readonly #validation: VideoCopyValidation;
  /** @internal */
  constructor(file: Blob, input: Input, track: InputVideoTrack, validation: VideoCopyValidation = 'strict') { this.#file = file; this.#input = input; this.#track = track; this.#validation = validation; }
  async #run<T>(options: VideoCopyOperation, job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#closing) fail('CLOSED', 'The video copy session is closed.');
    if (this.#pending) fail('BUSY', 'Await the previous video copy operation.');
    checkAbort(options.signal);
    const controller = new AbortController(), abort = () => controller.abort();
    this.#controller = controller; options.signal?.addEventListener('abort', abort, { once: true });
    const pending = Promise.resolve().then(() => job(controller.signal)); this.#pending = pending;
    try { return await pending; }
    catch (error) { checkAbort(controller.signal); throw mediaError(error, 'DECODE_FAILED'); }
    finally { options.signal?.removeEventListener('abort', abort); this.#pending = undefined; this.#controller = undefined; }
  }
  async inspect(options: VideoCopyOperation = {}): Promise<VideoCopyInfo> {
    return this.#run(options, signal => this.#inspect(signal, options.onProgress));
  }
  async #inspect(signal: AbortSignal, onProgress?: VideoCopyOperation['onProgress']): Promise<VideoCopyInfo> {
    checkAbort(signal); if (this.#info) return this.#info;
    if (await this.#track.getCodec() !== 'avc') copyFail('CODEC', 'Video copy requires H.264/AVC.');
    const container = await inspectCopyContainer(this.#file, this.#track.id, signal);
    const scale = await this.#track.getTimeResolution();
    if (!Number.isSafeInteger(scale) || scale < 1 || scale > 1_000_000) copyFail('TIMELINE', 'Unsupported track time resolution.');
    const config = await this.#track.getDecoderConfig();
    if (!config?.description) copyFail('CODEC', 'AVC decoder configuration is missing.');
    const raw = config.description;
    const description = ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice() : new Uint8Array(raw).slice();
    const relaxed = this.#validation === 'container', warnings = new CopyWarnings();
    let packetTime: number | undefined;
    const unverified = (code: VideoCopyDiagnosticCode, message: string, reason?: VideoCopyReason) => {
      if (!relaxed) copyProofFail(code, message, reason);
      warnings.add(code, message, { time: packetTime });
    };
    if (relaxed) warnings.add('CONTAINER_SYNC_UNVERIFIED', 'Container sync samples are used without guaranteeing independently decodable cuts.');
    // The validator is never disabled. NAL framing and SPS/PPS checks continue after every warning.
    const validator = new AvcCopyValidator(description, relaxed ? unverified : undefined), sink = new EncodedPacketSink(this.#track);
    const aspect = container.pixelAspectRatio ?? validator.pixelAspectRatio ?? { num: 1, den: 1 };
    // Preserve the rational SAR. The input convenience display width rounds to whole pixels (e.g. 4:3 -> 213:160).
    const aspectWidth = config.codedWidth! * aspect.num, aspectHeight = config.codedHeight! * aspect.den;
    if (!Number.isSafeInteger(aspectWidth) || !Number.isSafeInteger(aspectHeight) || aspectWidth > 0xffffffff || aspectHeight > 0xffffffff) copyFail('DISPLAY_METADATA', 'Aspect ratio exceeds the supported range.');
    config.displayAspectWidth = aspectWidth; config.displayAspectHeight = aspectHeight;
    const records: Record[] = [], boundaries: Boundary[] = [];
    let gopStart = 0, gopTick = 0, duration = 0, presentationEnd = 0;
    const seenTicks = new Set<number>();
    const finishGop = (end: number, eof = false) => {
      if (!eof && end !== gopTick + duration) unverified('GOP_TIMING_MISMATCH', 'GOP decode durations and presentation boundaries disagree.', 'TIMELINE');
      const sorted = records.slice(gopStart).sort((a, b) => a.tick - b.tick);
      if (!sorted.length || sorted[0].tick !== gopTick || sorted.at(-1)!.tick >= end) unverified('GOP_PRESENTATION_CROSSING', 'Pictures cross an IDR presentation boundary.');
      for (let i = 1; i < sorted.length; i++) if (sorted[i].tick <= sorted[i - 1].tick) copyFail('TIMELINE', 'Duplicate presentation timestamps.');
      if (!relaxed) {
        sorted.at(-1)!.duration = end - sorted.at(-1)!.tick;
        records.at(-1)!.duration = end - sorted.at(-1)!.tick;
      }
    };
    onProgress?.({ stage: 'inspecting', fraction: null, videoPackets: 0, audioSamples: 0 });
    let packet = await sink.getFirstPacket();
    while (packet) {
      checkAbort(signal);
      if (records.length >= 4_000_000 || packet.byteLength > 32 * 1024 * 1024) copyFail('LIMIT', 'Video copy index/packet limit exceeded.', 'RESOURCE_LIMIT');
      const tick = Math.round(packet.timestamp * scale), length = Math.round(packet.duration * scale);
      if (!Number.isSafeInteger(tick) || !Number.isSafeInteger(length) || !Number.isSafeInteger(tick + length) || tick < 0 || length <= 0 || Math.abs(packet.timestamp * scale - tick) > 1e-4
        || Math.abs(packet.duration * scale - length) > 1e-4) copyFail('TIMELINE', 'Unsupported negative, fractional or zero packet timing.');
      packetTime = packet.timestamp;
      if (seenTicks.has(tick)) copyFail('TIMELINE', 'Duplicate presentation timestamps.');
      seenTicks.add(tick);
      const idr = validator.inspect(packet.data), key = relaxed ? packet.type === 'key' : idr;
      if (idr !== (packet.type === 'key')) unverified('SYNC_IDR_MISMATCH', 'Sync-sample flag and IDR content disagree; open GOP is unsupported.');
      if (!records.length && !key) copyFail('NO_SAFE_BOUNDARY', relaxed ? 'Video must begin with a container sync sample.' : 'Video must begin with an IDR picture.');
      if (key) {
        if (records.length && tick <= gopTick) copyFail('TIMELINE', 'Start boundaries must increase in presentation time.');
        if (records.length) finishGop(tick);
        gopStart = records.length; gopTick = tick; duration = 0;
        const kind = relaxed ? 'sync' : 'idr';
        boundaries.push({ id: `${kind}:${packet.sequenceNumber}`, time: tick / scale, tick, kind, index: records.length });
      }
      if (records.length && packet.sequenceNumber <= records.at(-1)!.sequence) copyFail('GOP_STRUCTURE', 'Invalid decode order or leading pictures.');
      if (tick < gopTick) unverified('LEADING_PICTURE', 'Invalid decode order or leading pictures.');
      records.push({ tick, duration: length, sequence: packet.sequenceNumber, bytes: packet.byteLength, key });
      duration += length; presentationEnd = Math.max(presentationEnd, tick + length);
      if (!Number.isSafeInteger(duration)) copyFail('TIMELINE', 'GOP duration exceeds integer precision.');
      if (records.length % 128 === 0) { onProgress?.({ stage: 'inspecting', fraction: null, videoPackets: records.length, audioSamples: 0 }); await turn(); }
      packet = await sink.getNextPacket(packet);
    }
    if (!records.length) copyFail('NO_SAFE_BOUNDARY', 'Video track is empty.');
    let end = relaxed ? presentationEnd : gopTick + duration;
    const lastPresentation = records.slice(gopStart).reduce((max, r) => Math.max(max, r.tick), gopTick);
    if (container.editDuration !== null) {
      const editedEnd = boundaries[0].tick + Math.round(container.editDuration * scale);
      // A final edit may shorten the last displayed picture without removing any access units.
      // Other trims require preroll/discard logic and are deliberately rejected.
      if (editedEnd <= lastPresentation || editedEnd > end + Math.ceil(scale / container.movieScale)) copyFail('TIMELINE', 'The edit list discards pictures or extends the timeline.');
      end = Math.min(end, editedEnd);
    }
    finishGop(end, true);
    // The muxer derives DTS from sorted PTS. Its final decode sample therefore needs the final display interval.
    if (!relaxed) records.at(-1)!.duration = end - lastPresentation;
    boundaries.push({ id: 'eof', time: end / scale, tick: end, kind: 'eof', index: records.length });
    const intervals = boundaries.slice(1).map((b, i) => (b.tick - boundaries[i].tick) / scale);
    const matrix = await this.#track.getTransformationMatrix();
    if (matrix.some(x => !Number.isFinite(x)) || matrix[6] !== 0 || matrix[7] !== 0 || matrix[8] !== 1) copyFail('DISPLAY_METADATA', 'Perspective transformation is unsupported.');
    const info: VideoCopyInfo = freeze({ supported: true, validation: this.#validation, warnings: warnings.snapshot(), videoTrackId: this.#track.id, codec: 'h264', timeResolution: scale,
      startTime: boundaries[0].time, endTime: end / scale, videoPackets: records.length,
      width: await this.#track.getCodedWidth(), height: await this.#track.getCodedHeight(),
      displayWidth: await this.#track.getDisplayWidth(), displayHeight: await this.#track.getDisplayHeight(),
      rotation: await this.#track.getRotation(), pixelAspectRatio: freeze(aspect),
      colorSpace: freeze({ ...config.colorSpace }), transformationMatrix: freeze([...matrix]),
      boundaries: freeze(boundaries.map(({ index: _, ...b }) => freeze(b))),
      keyframeInterval: freeze({ min: intervals.reduce((a, b) => Math.min(a, b), Infinity), max: intervals.reduce((a, b) => Math.max(a, b), 0), mean: (end - boundaries[0].tick) / scale / intervals.length }) });
    checkAbort(signal);
    this.#records = records; this.#boundaries = boundaries; this.#config = { ...config, description }; this.#matrix = [...matrix]; this.#info = info;
    return info;
  }
  async findBoundaries(time: number, options: VideoCopyOperation = {}) {
    const info = await this.inspect(options);
    if (!Number.isFinite(time)) fail('INVALID_ARGUMENT', 'Time must be finite.');
    return { previous: info.boundaries.filter(b => b.time <= time).at(-1) ?? null, next: info.boundaries.find(b => b.time >= time) ?? null };
  }
  async plan(options: VideoCopyPlanOptions): Promise<VideoCopyPlan> {
    const keepRanges = Array.isArray(options.keepRanges) ? options.keepRanges.map(r => ({ ...r })) : undefined, snap = options.snap, rate = options.audioSampleRate;
    return this.#run(options, async signal => {
      const info = await this.#inspect(signal, options.onProgress), scale = info.timeResolution;
      if (!Array.isArray(keepRanges) || !keepRanges.length || !['strict', 'inside'].includes(snap)) copyFail('INVALID_RANGE', 'Provide nonempty keepRanges and strict/inside snapping.', 'INVALID_ARGUMENT');
      if (rate !== undefined) positive(rate, 'audioSampleRate', true);
      const ranges: VideoCopyRange[] = [], spans: Span[] = [], warnings = new CopyWarnings(info.warnings);
      let outputTick = 0, packets = 0, previousEnd = -Infinity, omittedVideoPackets = 0, adjustedVideoPackets = 0;
      for (const [index, r] of keepRanges.entries()) {
        checkAbort(signal);
        if (!Number.isFinite(r.start) || !Number.isFinite(r.end) || r.start < info.startTime || r.end > info.endTime || r.end <= r.start || r.start < previousEnd) copyFail('INVALID_RANGE', 'Keep ranges must be ordered, disjoint and within the video timeline.', 'INVALID_ARGUMENT', index);
        previousEnd = r.end;
        // Only accept numerical noise, not an arbitrary frame-sized snapping tolerance.
        const near = (t: number) => this.#boundaries.find(b => Math.abs(b.time - t) <= Math.max(1, Math.abs(t)) * Number.EPSILON * 8);
        const start = near(r.start) ?? (snap === 'inside' ? this.#boundaries.find(b => b.time > r.start) : undefined);
        const end = near(r.end) ?? (snap === 'inside' ? this.#boundaries.filter(b => b.time < r.end).at(-1) : undefined);
        if (!start || !end) copyFail('NO_SAFE_BOUNDARY', 'Requested boundary is unavailable in the selected validation mode.', 'INVALID_ARGUMENT', index);
        if (start.kind === 'eof' || start.tick >= end.tick) copyFail('EMPTY_RANGE', 'Snapping removed the entire keep range.', 'INVALID_ARGUMENT', index);
        const until = outputTick + end.tick - start.tick;
        if (!Number.isSafeInteger(until)) copyFail('LIMIT', 'Output timeline is too long.', 'RESOURCE_LIMIT');
        const fromSample = rate ? sampleAt(outputTick, rate, scale) : null, toSample = rate ? sampleAt(until, rate, scale) : null;
        if (toSample !== null && !Number.isSafeInteger(toSample)) copyFail('LIMIT', 'Audio timeline is too long.', 'RESOURCE_LIMIT');
        const span: Span = { from: start.index, until: end.index, sourceTick: start.tick, sourceEndTick: end.tick, outputTick, lastCopied: -1, lastPresentation: -1 };
        let omitted = 0, adjusted = 0;
        if (this.#validation === 'container') {
          for (let i = span.from; i < span.until; i++) {
            if ((i - span.from) % 4096 === 0) { await turn(); checkAbort(signal); }
            const record = this.#records[i];
            if (!this.#keepRecord(record, span)) {
              omitted++;
              warnings.add('PACKETS_OMITTED', 'Packets outside the retained presentation interval were omitted; references are not repaired.', { time: record.tick / scale, rangeIndex: index });
            } else { span.lastCopied = i; span.lastPresentation = Math.max(span.lastPresentation, record.tick); }
          }
          if (span.lastCopied < 0) copyFail('EMPTY_RANGE', 'No video pictures remain in this interval.', 'INVALID_ARGUMENT', index);
          for (let i = span.from; i < span.until; i++) {
            if ((i - span.from) % 4096 === 0) { await turn(); checkAbort(signal); }
            const record = this.#records[i];
            if (!this.#keepRecord(record, span)) continue;
            const duration = this.#recordDuration(record, i, span);
            if (duration !== record.duration) {
              adjusted++;
              warnings.add('PACKET_DURATION_ADJUSTED', 'Terminal packet duration was aligned to the planned boundary.',
                { time: record.tick / scale, rangeIndex: index, originalDuration: record.duration / scale, outputDuration: duration / scale });
            }
          }
        }
        omittedVideoPackets += omitted; adjustedVideoPackets += adjusted;
        ranges.push(freeze({ requestedStart: r.start, requestedEnd: r.end, sourceStart: start.time, sourceEnd: end.time,
          omittedVideoPackets: omitted, adjustedVideoPackets: adjusted,
          startAdjustment: start.time - r.start, endAdjustment: end.time - r.end, startBoundaryId: start.id, endBoundaryId: end.id,
          outputStart: outputTick / scale, outputEnd: until / scale,
          audioStartSample: fromSample, audioEndSample: toSample, audioSamples: toSample === null ? null : toSample - fromSample! }));
        spans.push(span); packets += end.index - start.index - omitted; outputTick = until;
      }
      const plan: VideoCopyPlan = freeze({ validation: this.#validation, warnings: warnings.snapshot(), omittedVideoPackets, adjustedVideoPackets,
        ranges: freeze(ranges), duration: outputTick / scale, audioSampleRate: rate ?? null,
        audioSamples: rate ? sampleAt(outputTick, rate, scale) : null, videoPackets: packets });
      this.#plans.set(plan, spans); return plan;
    });
  }
  #keepRecord(record: Record, span: Span) {
    return this.#validation !== 'container' || (record.tick >= span.sourceTick && record.tick < span.sourceEndTick);
  }
  #recordDuration(record: Record, index: number, span: Span) {
    return this.#validation === 'container' && (index === span.lastCopied || record.tick === span.lastPresentation)
      ? span.sourceEndTick - span.lastPresentation : record.duration;
  }
  async exportMp4(options: VideoCopyExportOptions): Promise<VideoCopyResult> {
    rejectEncodingOptions(options);
    const snapshot = { ...options, audio: options.audio && { ...options.audio }, target: options.target && { ...options.target } };
    return this.#run(snapshot, signal => this.#export(snapshot, signal));
  }
  async #export(o: VideoCopyExportOptions, signal: AbortSignal): Promise<VideoCopyResult> {
    const spans = this.#plans.get(o.plan), info = this.#info;
    if (!spans || !info) copyFail('PLAN_MISMATCH', 'Use an unchanged plan from this open session.', 'INVALID_ARGUMENT');
    const plan = o.plan, audio = o.audio?.mode === 'pcm' ? o.audio : undefined;
    if (o.audio && !['pcm', 'none'].includes(o.audio.mode)) fail('INVALID_ARGUMENT', 'Unknown audio mode.');
    if (audio) {
      positive(audio.sampleRate, 'audio.sampleRate', true); positive(audio.channels, 'audio.channels', true); positive(audio.bitrate, 'audio.bitrate', true);
      if (audio.codec !== undefined && audio.codec !== 'aac') fail('INVALID_ARGUMENT', 'Video copy accepts AAC audio only.');
      if (plan.audioSampleRate !== audio.sampleRate || typeof audio.blocks !== 'function') copyFail('PCM_FORMAT', 'Plan sample rate and PCM supplier must match the audio configuration.', 'INVALID_ARGUMENT');
      if (!await canEncodeAudio('aac', { sampleRate: audio.sampleRate, numberOfChannels: audio.channels, bitrate: audio.bitrate })) fail('UNSUPPORTED', 'AAC is unavailable for this exact configuration. Enable the AAC fallback with matching sampleRate, channels and audioBitrate.');
    }
    const target = o.target ?? { kind: 'blob' };
    if (target.kind === 'blob') positive(target.maxBytes ?? 256 * 1024 * 1024, 'maxBytes', true);
    else if (target.kind !== 'stream' || !target.stream || target.stream.locked) fail('INVALID_ARGUMENT', 'Expected an unlocked positioned stream.');
    checkAbort(signal);
    const store = target.kind === 'blob' ? new PagedBytes(target.maxBytes ?? 256 * 1024 * 1024) : undefined;
    const destination = target.kind === 'stream' ? target.stream.getWriter() : undefined;
    const readController = new AbortController(), abortRead = () => readController.abort();
    signal.addEventListener('abort', abortRead, { once: true });
    let ended = false, bytes = 0, videoBytes = 0, videoPackets = 0, audioSamples = 0;
    let iterator: AsyncIterator<PcmAudio> | undefined, pendingRead: Promise<IteratorResult<PcmAudio>> | undefined;
    let block: PcmAudio | undefined, offset = 0, exhausted = false, output: Output | undefined;
    let movie: { data: Uint8Array; position: number } | undefined;
    const progress = (stage: VideoCopyProgress['stage']) => o.onProgress?.({ stage, fraction: stage === 'complete' ? 1 : Math.min(.99, .99 * videoPackets / plan.videoPackets), videoPackets, audioSamples });
    const endDestination = async (error?: unknown) => {
      if (ended) return; ended = true;
      if (destination) try { if (error) await destination.abort(error); else await destination.close(); } finally { destination.releaseLock(); }
    };
    try {
      output = new Output({ format: new Mp4OutputFormat({ fastStart: false, onMoov: (data, position) => { movie = { data, position }; } }), target: new StreamTarget(new WritableStream<PositionedWrite>({
        async write(command) { checkAbort(signal); if (store) store.write(command); else await destination!.write(command); bytes = Math.max(bytes, command.position + command.data.length); },
      }), { chunked: true, chunkSize: 1024 * 1024 }) });
      const video = new EncodedVideoPacketSource('avc');
      // This is a tick grid, NOT a requested display fps. Every original timestamp is already on this grid.
      // 1.61.0 derives MP4 timescale from this metadata; no frames are created/dropped or resampled here.
      output.addVideoTrack(video, { decoderConfig: this.#config!, transformationMatrix: this.#matrix!, frameRate: info.timeResolution });
      const audioSource = audio ? new AudioSampleSource({ codec: 'aac', bitrate: audio.bitrate }) : undefined;
      if (audioSource) output.addAudioTrack(audioSource);
      await output.start(); checkAbort(signal);
      if (audio) iterator = audio.blocks(readController.signal)[Symbol.asyncIterator]();
      const nextBlock = async () => {
        pendingRead = Promise.resolve(iterator!.next());
        const next = await abortable(pendingRead, signal); pendingRead = undefined; checkAbort(signal);
        if (next.done) { exhausted = true; block = undefined; return; }
        validatePcm(next.value);
        if (next.value.sampleRate !== audio!.sampleRate || next.value.numberOfChannels !== audio!.channels) copyFail('PCM_FORMAT', 'PCM rate/channels changed.', 'INVALID_ARGUMENT');
        if (next.value.length > audio!.sampleRate * 10) copyFail('LIMIT', 'Supply PCM blocks of at most 10 seconds.', 'RESOURCE_LIMIT');
        if (audioSamples + next.value.length > plan.audioSamples!) copyFail('PCM_LENGTH', 'PCM exceeds the planned sample count.', 'INVALID_ARGUMENT');
        block = next.value; offset = 0;
      };
      const appendUntil = async (until: number) => {
        if (!audio || !audioSource) return;
        until = Math.min(until, plan.audioSamples!);
        while (audioSamples < until) {
          checkAbort(signal);
          if (!block || offset === block.length) await nextBlock();
          if (exhausted) copyFail('PCM_LENGTH', 'PCM ended before the planned sample count.', 'INVALID_ARGUMENT');
          const count = Math.min(4096, until - audioSamples, block!.length - offset), data = new Float32Array(count * audio.channels);
          for (let ch = 0; ch < audio.channels; ch++) {
            const values = block!.channelData[ch].subarray(offset, offset + count);
            if (values.some(x => !Number.isFinite(x))) copyFail('PCM_FORMAT', 'PCM values must be finite.', 'INVALID_ARGUMENT');
            data.set(values, ch * count);
          }
          const sample = new AudioSample({ data, format: 'f32-planar', sampleRate: audio.sampleRate, numberOfChannels: audio.channels,
            timestamp: (audioSamples - aacPrimingSamples()) / audio.sampleRate });
          try { await audioSource.add(sample); } finally { sample.close(); }
          checkAbort(signal); audioSamples += count; offset += count;
        }
      };
      const sink = new EncodedPacketSink(this.#track); let horizon = 0;
      for (const span of spans) {
        let packet = await sink.getKeyPacket(span.sourceTick / info.timeResolution);
        for (let i = span.from; i < span.until; i++) {
          checkAbort(signal);
          const record = this.#records[i];
          if (!packet || packet.sequenceNumber !== record.sequence || packet.data.byteLength !== record.bytes) copyFail('PLAN_MISMATCH', 'Indexed packet changed or is missing.');
          if (!this.#keepRecord(record, span)) {
            if (i + 1 < span.until) packet = await sink.getNextPacket(packet);
            continue;
          }
          const tick = span.outputTick + record.tick - span.sourceTick;
          const duration = this.#recordDuration(record, i, span);
          await video.add(packet.clone({ timestamp: tick / info.timeResolution, duration: duration / info.timeResolution }), { decoderConfig: this.#config! });
          checkAbort(signal); videoPackets++; videoBytes += packet.data.byteLength;
          horizon = Math.max(horizon, tick + duration);
          if (audio) await appendUntil(sampleAt(horizon, audio.sampleRate, info.timeResolution));
          if (videoPackets % 128 === 0) { progress('copying'); await turn(); }
          if (i + 1 < span.until) packet = await sink.getNextPacket(packet);
        }
      }
      if (audio) {
        await appendUntil(plan.audioSamples!);
        if (block && offset !== block.length) copyFail('PCM_LENGTH', 'PCM exceeds the planned sample count.', 'INVALID_ARGUMENT');
        await nextBlock(); if (!exhausted) copyFail('PCM_LENGTH', 'PCM has extra blocks.', 'INVALID_ARGUMENT');
      }
      video.close(); audioSource?.close(); progress('finalizing'); checkAbort(signal);
      await output.finalize(); checkAbort(signal);
      if (!movie || movie.position + movie.data.length !== bytes) copyFail('CONTAINER', 'Expected final moov box at end of output.');
      const patched = { type: 'write' as const, data: trimCopyMoov(movie.data, plan.duration), position: movie.position };
      if (store) store.write(patched); else await destination!.write(patched);
      bytes = Math.max(bytes, patched.position + patched.data.length); checkAbort(signal);
      await endDestination(); checkAbort(signal);
      const result: VideoCopyResult = { videoMode: 'copy', validation: this.#validation, warnings: plan.warnings,
        omittedVideoPackets: plan.omittedVideoPackets, adjustedVideoPackets: plan.adjustedVideoPackets,
        plan, duration: plan.duration, blob: store?.blob() ?? null, bytes,
        videoBytes, averageVideoBitrate: videoBytes * 8 / plan.duration, videoPackets, audioSamples, videoCodec: 'h264', audioCodec: audio ? 'aac' : null,
        width: info.width, height: info.height, displayWidth: info.displayWidth, displayHeight: info.displayHeight, rotation: info.rotation };
      progress('complete'); return result;
    } catch (error) {
      readController.abort();
      try { await output?.cancel(); } catch { /* Original error wins. */ }
      try { await endDestination(error); } catch { /* Original error wins. */ }
      store?.clear(); checkAbort(signal); throw mediaError(error, 'ENCODE_FAILED');
    } finally {
      readController.abort(); signal.removeEventListener('abort', abortRead);
      // Do not call return concurrently with a pending next. Non-cooperative suppliers may delay this await.
      try { await pendingRead; } catch { /* Original error wins. */ }
      try { await iterator?.return?.(); } catch { /* Do not replace a media error. */ }
    }
  }
  async close(): Promise<void> {
    this.#closing = true; this.#controller?.abort();
    try { await this.#pending; } catch { /* The operation reports its own error. */ }
    this.#input.dispose(); this.#records = []; this.#boundaries = []; this.#plans = new WeakMap();
  }
}

export async function openVideoCopy(file: Blob, options: { videoTrackId?: number; signal?: AbortSignal; validation?: VideoCopyValidation } = {}): Promise<VideoCopySession> {
  checkAbort(options.signal);
  if (options.validation !== undefined && !['strict', 'container'].includes(options.validation)) fail('INVALID_ARGUMENT', 'Unknown video copy validation mode.');
  if (!(file instanceof Blob) || !file.size) fail('INVALID_ARGUMENT', 'Expected a nonempty MP4 Blob/File.');
  const input = new Input({ formats: [MP4], source: new BlobSource(file, { maxCacheSize: 8 * 1024 * 1024 }) });
  try {
    const tracks = await input.getVideoTracks(); checkAbort(options.signal);
    const track = options.videoTrackId === undefined ? tracks[0] : tracks.find(t => t.id === options.videoTrackId);
    if (!track) copyFail('CODEC', 'Requested video track is missing.');
    return new VideoCopySession(file, input, track, options.validation);
  } catch (error) { input.dispose(); throw mediaError(error, 'DECODE_FAILED'); }
}
