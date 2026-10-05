import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { verifyMedia } from '../../scripts/verify-media.mjs';
import type {} from './harness/public-input';

test('public entry and AAC import graph exclude the private adapter even without tree shaking', async () => {
  const bundle = async (entry: string) => build({
    stdin: { contents: `import * as api from '${entry}'; import * as aac from 'browser-media-io/aac'; globalThis.api = { ...api, ...aac };`, resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'browser', treeShaking: false, metafile: true,
  });
  const normal = await bundle('browser-media-io/public');
  const strict = await bundle('browser-media-io');
  expect(Object.keys(normal.metafile!.inputs)).not.toContain('dist/decoder-session.js');
  expect(Object.keys(normal.metafile!.inputs)).not.toContain('dist/input.js');
  expect(Object.keys(strict.metafile!.inputs)).toContain('dist/decoder-session.js');
});

test('public probe and AudioBuffer adapter preserve input behavior', async ({ page }) => {
  await page.goto('/public.html'); await page.waitForFunction(() => !!window.publicInputHarness);
  const result = await page.evaluate(async () => {
    const api = window.publicInputHarness.api;
    const file = async (name: string) => (await fetch(name)).blob();
    const wav = await api.probe(await file('/reference.wav'));
    const mp3 = await api.probe(await file('/wrong-duration.mp3'));
    const input = await api.openMedia(await file('/reference.mp4'));
    let samples = 0, start: number | undefined, end: number | undefined;
    try {
      for await (const block of input.audioBlocks({ start: 4.01, end: 5.01 })) {
        start ??= block.timestamp; samples += block.buffer.length;
        end = block.timestamp + block.buffer.duration;
      }
    } finally { input.close(); }
    return { wav, mp3, samples, start, end, sameAlias: api.openMedia === api.openMediaPublic };
  });
  expect(result.wav.tracks[0].audio).toEqual({ sampleRate: 48000, channels: 2 });
  expect(result.mp3.duration.seconds!).toBeGreaterThan(9.9);
  expect(result.mp3.tracks[0].metadataDuration!).toBeLessThan(6);
  expect(result.samples).toBe(48000); expect(result.start).toBeCloseTo(4.01, 6); expect(result.end).toBeCloseTo(5.01, 6);
  expect(result.sameAlias).toBe(true);
});

for (const worker of [false, true]) test(`public API MP4/PCM roundtrip and cancellation; worker=${worker}`, async ({ page }, info) => {
  await page.goto('/public.html'); await page.waitForFunction(() => !!window.publicInputHarness);
  const [download, result] = await Promise.all([page.waitForEvent('download'),
    page.evaluate(worker => window.publicInputHarness.roundtrip(worker), worker)]);
  const file = info.outputPath('public-roundtrip.mp4'); await download.saveAs(file);
  expect(result.result.videoFrames).toBe(300); expect(result.result.audioSamples).toBe(480000);
  expect(result.info.tracks.find(t => t.kind === 'video')!.packetCount).toBe(300);
  expect(result.audioBufferAvailable).toBe(!worker);
  const verified = verifyMedia(file, 'aac', { pulseTolerance: .005 });
  await info.attach('public-roundtrip.json', { body: JSON.stringify({ ...result, verified: { ...verified, ffprobe: undefined } }), contentType: 'application/json' });
});
