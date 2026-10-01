import { test, expect } from '@playwright/test';
import { verifyMedia, probe as ffprobe } from '../../scripts/verify-media.mjs';
import type {} from './harness/main';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.mediaHarness);
});

test('probe keeps metadata and packet evidence distinct; audio-only inputs work', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { api, file } = window.mediaHarness;
    const video = await file('/reference.mp4');
    return {
      metadata: await api.probe(video, { mode: 'metadata' }),
      scan: await api.probe(video),
      wav: await api.probe(await file('/reference.wav')),
      mp3: await api.probe(await file('/wrong-duration.mp3')),
    };
  });
  expect(result.metadata.duration.source).toBe('metadata');
  expect(result.metadata.tracks[0].packetCount).toBeNull();
  expect(result.scan.duration.source).toBe('packets');
  const video = result.scan.tracks.find(t => t.kind === 'video')!;
  expect(video.packetCount).toBe(300);
  expect(video.video).toMatchObject({ averageFrameRate: 30, cadence: 'constant' });
  expect(result.wav.tracks).toHaveLength(1);
  expect(result.wav.tracks[0].audio).toEqual({ sampleRate: 48000, channels: 2 });
  expect(result.mp3.duration.seconds!).toBeGreaterThan(9.9);
  expect(result.mp3.tracks[0].metadataDuration!).toBeLessThan(6);
});

test('frame ownership, bounded handles, EOS and input cancellation', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { api, file } = window.mediaHarness;
    const code = async (fn: () => Promise<unknown>) => { try { await fn(); return 'ok'; } catch (e) { return (e as { code: string }).code; } };
    const controller = new AbortController();
    const input = await api.openMedia(await file('/reference.mp4'), { maxOutstandingFrames: 2, signal: controller.signal });
    const a = await input.getVideoFrame(0), b = await input.getVideoFrame(1);
    const limit = await code(() => input.getVideoFrame(2));
    a!.close();
    const c = await input.getVideoFrame(2); c!.close();
    const end = await input.getVideoFrame(10);
    controller.abort();
    const afterAbort = await code(() => input.getVideoFrame(3));
    return { limit, end, afterAbort, closed: input.closed, frameClosed: b!.closed };
  });
  expect(result).toEqual({ limit: 'RESOURCE_LIMIT', end: null, afterAbort: 'ABORTED', closed: true, frameClosed: true });
});

test('audioBlocks clips a requested interval exactly at PCM sample boundaries', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { api, file } = window.mediaHarness;
    const input = await api.openMedia(await file('/reference.mp4'));
    const blocks = [];
    try {
      for await (const { buffer, timestamp } of input.audioBlocks({ start: 4.01, end: 5.01 })) {
        blocks.push({ timestamp, samples: buffer.length, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels });
      }
    } finally { input.close(); }
    return blocks;
  });
  expect(result.length).toBeGreaterThan(1);
  expect(result.reduce((n, b) => n + b.samples, 0)).toBe(48000);
  expect(result[0].timestamp).toBeCloseTo(4.01, 6);
  const last = result.at(-1)!;
  expect(last.timestamp + last.samples / last.sampleRate).toBeCloseTo(5.01, 6);
  for (let i = 1; i < result.length; i++) expect(result[i].timestamp).toBeCloseTo(result[i - 1].timestamp + result[i - 1].samples / 48000, 6);
});

for (const streaming of [false, true]) {
  test(`Canvas plus WAV produces H.264/AAC MP4; stream=${streaming}`, async ({ page }, testInfo) => {
    const [download, result] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(streaming => window.mediaHarness.synthetic(streaming), streaming),
    ]);
    expect(result.streamed).toBe(streaming);
    expect(result.audioSamples).toBe(480000);
    const file = testInfo.outputPath('synthetic.mp4');
    await download.saveAs(file);
    const verification = verifyMedia(file, 'aac', { pulseTolerance: 0.005 });
    await testInfo.attach('verification.json', { body: JSON.stringify(verification), contentType: 'application/json' });
    await testInfo.attach('synthetic.mp4', { path: file, contentType: 'video/mp4' });
  });
}

test('two independent videos share the output clock at a fractional frame rate', async ({ page }, testInfo) => {
  const [download, result] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(async () => {
      const { api, file } = window.mediaHarness;
      const blob = await file('/reference.mp4');
      const a = await api.openMedia(blob), b = await api.openMedia(blob);
      const ids: { n: number; time: number; left: number; right: number }[] = [];
      try {
        const result = await api.renderMp4({ width: 320, height: 180, fps: { numerator: 30000, denominator: 1001 }, duration: 1.001,
          renderFrame: async (ctx, time, n) => {
            const [left, right] = await Promise.all([a.getVideoFrame(time), b.getVideoFrame(time + 1)]);
            try {
              if (!left || !right) throw new Error('Missing frame');
              ids.push({ n, time, left: Math.round(left.timestamp * 30), right: Math.round(right.timestamp * 30) });
              left.draw(ctx, 0, 0, 160, 180); right.draw(ctx, 160, 0, 160, 180);
            } finally { left?.close(); right?.close(); }
          },
        });
        const link = document.createElement('a'); link.href = URL.createObjectURL(result.blob!); link.download = 'fractional.mp4'; link.click();
        return { ids, frames: result.videoFrames, duration: result.duration };
      } finally { a.close(); b.close(); }
    }),
  ]);
  expect(result.frames).toBe(30);
  expect(result.duration).toBeCloseTo(1.001, 9);
  for (const entry of result.ids) {
    expect(entry.left).toBe(entry.n); expect(entry.right).toBe(entry.n + 30);
    expect(entry.time).toBeCloseTo(entry.n * 1001 / 30000, 10);
  }
  const output = testInfo.outputPath('fractional.mp4'); await download.saveAs(output);
  const info = ffprobe(output);
  expect(Number(info.streams[0].nb_read_frames)).toBe(30);
  const frames = info.frames.filter((f: { media_type: string }) => f.media_type === 'video');
  for (let i = 0; i < frames.length; i++) expect(Math.abs(Number(frames[i].best_effort_timestamp_time) - i * 1001 / 30000)).toBeLessThan(0.000002);
});

test('renderer cancellation aborts its destination and never reports completion', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { api } = window.mediaHarness;
    const controller = new AbortController();
    let aborted = false, closed = false, rendered = 0;
    const progress: string[] = [];
    const stream = new WritableStream({ write() {}, close() { closed = true; }, abort() { aborted = true; } });
    let code = '';
    try {
      await api.renderMp4({ width: 320, height: 180, fps: 30, duration: 10, signal: controller.signal,
        target: { kind: 'stream', stream }, onProgress: p => progress.push(p.stage),
        renderFrame: ctx => { rendered++; ctx.fillRect(0, 0, 320, 180); if (rendered === 5) controller.abort(); },
      });
    } catch (error) { code = (error as { code: string }).code; }
    const recovery = await api.renderMp4({ width: 320, height: 180, fps: 30, duration: 0.1, renderFrame: ctx => ctx.fillRect(0, 0, 320, 180) });
    return { code, rendered, aborted, closed, progress, locked: stream.locked, recoveryFrames: recovery.videoFrames };
  });
  expect(result).toMatchObject({ code: 'ABORTED', rendered: 5, aborted: true, closed: false, locked: false, recoveryFrames: 3 });
  expect(result.progress).not.toContain('complete');
});

test('bad arguments, output limits, destination failures and frame ownership are explicit', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { api } = window.mediaHarness;
    const code = async (fn: () => Promise<unknown>) => { try { await fn(); return 'ok'; } catch (e) { return (e as { code: string }).code; } };
    const base = { width: 320, height: 180, fps: 30, duration: 0.1, renderFrame: (ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D) => ctx.fillRect(0, 0, 320, 180) };
    const invalid = await code(() => api.createMp4Writer({ width: 321, height: 180, fps: 30 }));
    const limit = await code(() => api.renderMp4({ ...base, target: { kind: 'blob', maxBytes: 32 } }));
    const stream = new WritableStream({ write() { throw new Error('Disk is full'); } });
    const failure = await code(() => api.renderMp4({ ...base, target: { kind: 'stream', stream } }));
    const writer = await api.createMp4Writer({ width: 320, height: 180, fps: 30, expectedFrames: 2 });
    const canvas = new OffscreenCanvas(320, 180);
    canvas.getContext('2d')!.fillRect(0, 0, 320, 180);
    const frame = new VideoFrame(canvas, { timestamp: 123 });
    await writer.addVideoFrame(frame);
    const borrowedFrameStillOpen = frame.codedWidth === 320;
    frame.close();
    const missingFrame = await code(() => writer.finish());
    const afterFailure = await code(() => writer.addVideoFrame(new OffscreenCanvas(320, 180)));
    const support = await api.getCapabilities({ width: 320, height: 180 });
    const unsupportedAac = !support.nativeAacEncode ? await code(() => api.createMp4Writer({ width: 320, height: 180, fps: 30, audio: { sampleRate: 48000, channels: 2 } })) : 'native-supported';
    const empty = await code(() => api.openMedia(new Blob([])));
    const junk = await code(() => api.openMedia(new Blob(['not a media file'])));
    return { invalid, limit, failure, locked: stream.locked, borrowedFrameStillOpen, missingFrame, afterFailure, unsupportedAac, empty, junk };
  });
  expect(result).toMatchObject({ invalid: 'INVALID_ARGUMENT', limit: 'RESOURCE_LIMIT', failure: 'ENCODE_FAILED', locked: false,
    borrowedFrameStillOpen: true, missingFrame: 'INVALID_ARGUMENT', afterFailure: 'CLOSED', empty: 'INVALID_ARGUMENT', junk: 'UNSUPPORTED' });
  expect(['UNSUPPORTED', 'native-supported']).toContain(result.unsupportedAac);
});
