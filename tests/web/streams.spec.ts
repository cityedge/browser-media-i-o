import { test, expect } from '@playwright/test';
import type {} from './harness/main';

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.waitForFunction(() => !!window.mediaHarness); });

test('sequential B/VFR/offset/gap frames agree with independent FFprobe timing', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { api, file } = window.mediaHarness;
    const truth = await (await fetch('/timing.json')).json();
    const results = [];
    for (const name of ['reference.mp4', 'variable.mp4', 'gaps.mp4']) {
      const input = await api.openMedia(await file(`/${name}`));
      const actual = [];
      try {
        for await (const frame of input.videoFrames()) {
          actual.push({ timestamp: frame.timestamp, duration: frame.duration }); frame.close();
        }
      } finally { input.close(); }
      results.push({ name, actual, expected: truth[name] as { timestamp: number; duration: number; type: string }[] });
    }
    return results;
  });
  for (const { actual, expected } of result) {
    expect(actual).toHaveLength(expected.length);
    actual.forEach((f, i) => {
      expect(f.timestamp).toBeCloseTo(expected[i].timestamp, 6);
      expect(f.duration).toBeCloseTo(expected[i].duration, 6);
    });
  }
  expect(result[0].expected.some(f => f.type === 'B')).toBe(true);
  expect(new Set(result[1].expected.map(f => f.duration)).size).toBeGreaterThan(1);
  expect(result[2].expected.map(f => f.timestamp)).toEqual([1, 1.1, 2, 2.3]);
  expect(result[2].expected.map(f => f.duration)).toEqual([.1, .1, .1, .1]);
});

test('half-open boundaries, actual gaps, early offsets and independent repeated frame handles', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { api, file } = window.mediaHarness;
    const input = await api.openMedia(await file('/gaps.mp4'));
    const times = [0, .999999, 1, 1.05, 1.099999, 1.1, 1.199999, 1.2, 1.200001, 1.9, 2, 2.1, 2.3, 2.399999, 2.4, 3];
    const requested = [], single = [], ranges = [];
    try {
      for await (const { time, frame } of input.videoFramesAt(times)) {
        requested.push([time, frame?.timestamp ?? null]); frame?.close();
      }
      for (const t of times) { const f = await input.getVideoFrame(t); single.push(f?.timestamp ?? null); f?.close(); }
      for (const [start, end] of [[1.05, 1.15], [1.1, 1.2], [1.2, 2], [2.1, 2.3], [2.399999, 2.4]]) {
        const items = [];
        for await (const f of input.videoFrames({ start, end })) { items.push(f.timestamp); f.close(); }
        ranges.push(items);
      }
      const reader = input.videoFramesAt([1, 1, 1.05]);
      const a = (await reader.next()).value!.frame!, b = (await reader.next()).value!.frame!;
      a.close(); const c = (await reader.next()).value!.frame!;
      await reader.return();
      const ctx = new OffscreenCanvas(160, 96).getContext('2d')!; b.draw(ctx); c.draw(ctx);
      const native = b.toVideoFrame(); b.close();
      const independent = !c.closed && native.codedWidth === 160; native.close(); c.close();
      return { requested, single, ranges, independent };
    } finally { input.close(); }
  });
  const values = [null, null, 1, 1, 1, 1.1, 1.1, null, null, null, 2, null, 2.3, 2.3, null, null];
  expect(result.requested.map(x => x[1])).toEqual(values);
  expect(result.single).toEqual(values);
  expect(result.ranges).toEqual([[1, 1.1], [1.1], [], [], [2.3]]);
  expect(result.independent).toBe(true);
});

test('abort/return during initialization, pending next and paused yield joins real decoders before reuse', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { api, file } = window.mediaHarness;
    const Native = VideoDecoder, live = new Set<VideoDecoder>();
    let created = 0, peak = 0, outputs = 0;
    window.VideoDecoder = class extends Native {
      constructor(init: VideoDecoderInit) {
        super({ ...init, output(frame) { outputs++; init.output(frame); } });
        live.add(this); created++; peak = Math.max(peak, live.size);
      }
      close() { try { super.close(); } finally { live.delete(this); } }
    };
    const input = await api.openMedia(await file('/reference.mp4'));
    const failures: string[] = [], postReturn = [], held = [];
    try {
      for (let n = 0; n < 36; n++) {
        const controller = new AbortController();
        const reader = input.videoFrames({ start: (n % 9) + .01, signal: controller.signal });
        if (n % 3 === 0) {
          const pending = reader.next().then(x => { if (!x.done) x.value.close(); return 'done'; }, e => e.code);
          controller.abort(); await reader.return(); failures.push(await pending);
        } else {
          const first = (await reader.next()).value!;
          if (n % 3 === 1) {
            const pending = reader.next().then(x => { if (!x.done) x.value.close(); return 'done'; }, e => e.code);
            controller.abort(); await reader.return(); failures.push(await pending);
          } else { controller.abort(); await reader.return(); }
          held.push(!first.closed); first.close();
        }
        await reader.return(); postReturn.push(live.size);
        const next = await input.getVideoFrame((8 - n % 9) + .01); next!.close(); postReturn.push(live.size);
      }
      // A slow consumer must stop the decoder producer, not build an unbounded queue.
      const slow = input.videoFrames(); (await slow.next()).value!.close();
      await new Promise(r => setTimeout(r, 100)); const before = outputs;
      await new Promise(r => setTimeout(r, 150)); const after = outputs;
      await slow.return();
      const finalReader = input.videoFrames(), final = (await finalReader.next()).value!;
      input.close(); await finalReader.return();
      return { created, peak, postReturn, failures, held, queuedWhilePaused: after - before, closedOnInputClose: final.closed };
    } finally { input.close(); window.VideoDecoder = Native; }
  });
  expect(result.created).toBeGreaterThan(40);
  expect(result.peak).toBe(1);
  expect(result.postReturn.every(n => n === 0)).toBe(true);
  expect(result.failures.every(code => code === 'ABORTED')).toBe(true);
  expect(result.held.every(Boolean)).toBe(true);
  expect(result.queuedWhilePaused).toBe(0);
  expect(result.closedOnInputClose).toBe(true);
});

test('independent video/audio reads, PCM ownership, exclusive same-input reads and recovery on errors', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { api, file } = window.mediaHarness;
    const blob = await file('/reference.mp4');
    const a = await api.openMedia(blob), b = await api.openMedia(blob);
    const codes: string[] = [];
    const code = async (fn: () => Promise<unknown>) => { try { await fn(); return 'ok'; } catch (e) { return (e as { code: string }).code; } };
    const controller = new AbortController();
    const audio = a.audioPcmBlocks({ start: .01, end: 1.01, maxBlockSamples: 37, signal: controller.signal });
    try {
      const first = (await audio.next()).value!, copy = Array.from(first.channelData[0]);
      codes.push(await code(() => a.getVideoFrame(0)));
      const video = b.videoFramesAt([1, 2, 3]);
      (await video.next()).value!.frame!.close();
      controller.abort(); await audio.return();
      const f = (await video.next()).value!.frame!; const otherTimestamp = f.timestamp; f.close(); await video.return();
      const after = await a.getVideoFrame(5); after!.close();
      for (const times of [[1, 0], [-1], [NaN], [Infinity]]) {
        codes.push(await code(async () => { for await (const item of a.videoFramesAt(times)) item.frame?.close(); }));
        (await a.getVideoFrame(0))!.close();
      }
      const probeController = new AbortController();
      codes.push(await code(() => a.probe({ signal: probeController.signal, onProgress() { probeController.abort(); } })));
      (await a.getVideoFrame(0))!.close();
      return { codes, otherTimestamp, owned: copy.every((v, i) => v === first.channelData[0][i]), length: first.length };
    } finally { await audio.return(); a.close(); b.close(); }
  });
  expect(result.codes).toEqual(['BUSY', 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'ABORTED']);
  expect(result.otherTimestamp).toBe(2); expect(result.owned).toBe(true); expect(result.length).toBeLessThanOrEqual(37);
});

test('PCM slices are sample exact and remain usable after input closes', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { api, file } = window.mediaHarness, blob = await file('/reference.wav');
    const decoded = await api.decodeAudio(blob), input = await api.openMedia(blob);
    let count = 0, maxError = 0, maxTimeError = 0, maxLength = 0, lastEnd = .01;
    const blocks = [];
    for await (const block of input.audioPcmBlocks({ start: .01, end: 1.01, maxBlockSamples: 337 })) {
      const offset = Math.round(block.timestamp * block.sampleRate);
      maxTimeError = Math.max(maxTimeError, Math.abs(block.timestamp - lastEnd));
      for (let c = 0; c < 2; c++) for (let n = 0; n < block.length; n++)
        maxError = Math.max(maxError, Math.abs(block.channelData[c][n] - decoded.buffer.getChannelData(c)[offset + n]));
      count += block.length; maxLength = Math.max(maxLength, block.length);
      lastEnd = block.timestamp + block.length / block.sampleRate; blocks.push(block);
    }
    input.close();
    const transferred = structuredClone(blocks[0], { transfer: blocks[0].channelData.map(c => c.buffer) });
    return { count, maxError, maxTimeError, maxLength, lastEnd, detached: blocks[0].channelData[0].byteLength === 0, transferred: transferred.length };
  });
  expect(result.count).toBe(48000); expect(result.maxTimeError).toBeLessThan(1e-10);
  expect(result.maxError).toBeLessThan(1 / 32768); // Web Audio / PCM decoder normalization differs by < one 16-bit step.
  expect(result.maxLength).toBeLessThanOrEqual(337); expect(result.lastEnd).toBeCloseTo(1.01, 8);
  expect(result.detached).toBe(true); expect(result.transferred).toBeGreaterThan(0);
});

test('AAC PCM readers join native decoders at initialization, next and yield cancellation points', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { api, file } = window.mediaHarness, Native = AudioDecoder;
    const live = new Set<AudioDecoder>(); let peak = 0, created = 0;
    window.AudioDecoder = class extends Native {
      constructor(init: AudioDecoderInit) { super(init); live.add(this); created++; peak = Math.max(peak, live.size); }
      close() { try { super.close(); } finally { live.delete(this); } }
    };
    const input = await api.openMedia(await file('/reference.mp4')), counts = [], codes = [];
    try {
      for (let n = 0; n < 18; n++) {
        const controller = new AbortController(), reader = input.audioPcmBlocks({ start: n % 8, signal: controller.signal, maxBlockSamples: 97 });
        if (n % 3) await reader.next();
        if (n % 3 === 2) { controller.abort(); await reader.return(); }
        else {
          const pending = reader.next().then(() => 'done', e => e.code);
          controller.abort(); await reader.return(); codes.push(await pending);
        }
        counts.push(live.size);
        const fresh = input.audioPcmBlocks({ start: 8 - n % 8 });
        const block = (await fresh.next()).value!;
        if (block.timestamp < 8 - n % 8) throw new Error('Old PCM appeared in a new read');
        await fresh.return(); counts.push(live.size);
      }
      return { created, peak, counts, codes };
    } finally { input.close(); window.AudioDecoder = Native; }
  });
  expect(result.created).toBeGreaterThan(18); expect(result.peak).toBe(1);
  expect(result.counts.every(n => n === 0)).toBe(true);
  expect(result.codes.every(code => code === 'ABORTED')).toBe(true);
});

test('requested times are lazy and outstanding frame limits survive reader return', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { api, file } = window.mediaHarness, input = await api.openMedia(await file('/reference.mp4'), { maxOutstandingFrames: 2 });
    let consumed = 0, finalized = false, code = '';
    const times = function* () { try { while (true) { consumed++; yield .1; } } finally { finalized = true; } };
    const reader = input.videoFramesAt(times());
    try {
      const a = (await reader.next()).value!.frame!, b = (await reader.next()).value!.frame!;
      await reader.return();
      try { await input.getVideoFrame(1); } catch (e) { code = (e as { code: string }).code; }
      const stillOwned = !a.closed && !b.closed;
      a.close(); b.close(); const recovered = await input.getVideoFrame(1); recovered!.close();
      return { consumed, finalized, code, stillOwned, timestamp: recovered!.timestamp };
    } finally { await reader.return(); input.close(); }
  });
  expect(result).toEqual({ consumed: 2, finalized: true, code: 'RESOURCE_LIMIT', stillOwned: true, timestamp: 1 });
});
