import { test, expect } from '@playwright/test';
import { verifyMedia } from '../../scripts/verify-media.mjs';
import type {} from './harness/main';

test.beforeEach(async ({ page }) => { await page.goto('/'); await page.waitForFunction(() => !!window.mediaHarness); });

for (const worker of [false, true]) for (const canvasPath of [false, true]) {
  test(`two videos -> WebGL -> MP4 with decoded PCM; worker=${worker}, canvas=${canvasPath}`, async ({ page }, info) => {
    const [download, result] = await Promise.all([page.waitForEvent('download'),
      page.evaluate(({ worker, canvasPath }) => window.mediaHarness.twoVideos(worker, canvasPath), { worker, canvasPath })]);
    const file = info.outputPath('gpu.mp4'); await download.saveAs(file);
    expect(result.result.videoFrames).toBe(300); expect(result.result.audioSamples).toBe(480000);
    expect(result.audioBufferAvailable).toBe(!worker);
    expect(result.workerProbePackets).toBe(worker ? 300 : undefined);
    const verified = verifyMedia(file, 'aac', { width: 640, markerOffsets: [0, 320], pulseTolerance: .005 });
    await info.attach('gpu-result.json', { body: JSON.stringify({ ...result, verified }), contentType: 'application/json' });
  });
}

for (const canvasPath of [false, true]) test(`gray values, aspect ratio, rotations and flips; canvas=${canvasPath}`, async ({ page }, info) => {
  const results = await page.evaluate(p => window.mediaHarness.grayRoundtrip(p), canvasPath);
  await info.attach('gray-values.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  const corners = [[32, 96, 160, 224], [160, 32, 224, 96], [224, 160, 96, 32], [96, 224, 32, 160]];
  for (const result of results) {
    const expected = corners[result.rotation / 90].slice();
    if (result.flip) { [expected[0], expected[1]] = [expected[1], expected[0]]; [expected[2], expected[3]] = [expected[3], expected[2]]; }
    expect(result.squarePixelWidth).toBe(192); expect(result.squarePixelHeight).toBe(96);
    expect([result.width, result.height]).toEqual(result.rotation % 180 ? [96, 192] : [192, 96]);
    for (let n = 0; n < 4; n++) {
      expect(Math.abs(result.corners2d[n] - expected[n])).toBeLessThanOrEqual(4);
      expect(Math.abs(result.cornersGl[n] - expected[n])).toBeLessThanOrEqual(6);
    }
    for (let n = 0; n < 5; n++) {
      const value = [0, 64, 128, 192, 255][n];
      expect(Math.abs(result.before[n] - value)).toBeLessThanOrEqual(4);
      expect(Math.abs(result.after[n] - value)).toBeLessThanOrEqual(6);
    }
  }
  expect(await page.evaluate(() => window.mediaHarness.croppedUpload())).toBeLessThanOrEqual(1);
});

test('PCM validation and early finish preserve the writer contracts', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { api } = window.mediaHarness; await api.enableAacFallback({ width: 320, height: 180 });
    const code = async (fn: () => Promise<unknown>) => { try { await fn(); return 'ok'; } catch (e) { return (e as { code: string }).code; } };
    const base = { width: 320, height: 180, fps: 30, audio: { sampleRate: 48000, channels: 2 } };
    const pcm = { sampleRate: 48000, numberOfChannels: 2, length: 1600, channelData: [new Float32Array(1600), new Float32Array(1600)] };
    const invalid = [];
    for (const patch of [{ sampleRate: 44100 }, { numberOfChannels: 1 }, { length: 0 }, { channelData: [new Float32Array(1), new Float32Array(1)] },
      { channelData: [new Float32Array(1600).fill(NaN), new Float32Array(1600)] }]) {
      const writer = await api.createMp4Writer(base);
      invalid.push(await code(() => writer.addPcm({ ...pcm, ...patch }))); await writer.cancel();
    }
    const empty = await api.createMp4Writer(base); const emptyCode = await code(() => empty.finish());
    const mismatch = await api.createMp4Writer(base), canvas = new OffscreenCanvas(320, 180);
    canvas.getContext('2d')!.fillRect(0, 0, 320, 180);
    await mismatch.addVideoFrame(canvas); await mismatch.addPcm({ ...pcm, length: 48000, channelData: [new Float32Array(48000), new Float32Array(48000)] });
    const mismatchCode = await code(() => mismatch.finish());
    const writer = await api.createMp4Writer(base);
    for (let n = 0; n < 3; n++) { await writer.addVideoFrame(canvas); await writer.addPcm(pcm); pcm.channelData[0].fill(.1); }
    const finished = await writer.finish(), input = await api.openMedia(finished.blob!); const probe = await input.probe(); input.close();
    return { invalid, emptyCode, mismatchCode, frames: finished.videoFrames, samples: finished.audioSamples, duration: finished.duration,
      borrowed: pcm.channelData[0].byteLength, packets: probe.tracks.find(t => t.kind === 'video')!.packetCount };
  });
  expect(result.invalid.every(x => x === 'INVALID_ARGUMENT')).toBe(true);
  expect(result).toMatchObject({ emptyCode: 'INVALID_ARGUMENT', mismatchCode: 'INVALID_ARGUMENT', frames: 3, samples: 4800, duration: .1, borrowed: 6400, packets: 3 });
});
