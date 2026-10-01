import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ffmpeg, fixtureDir, truth } from '../../scripts/generate-fixtures.mjs';
import { probe, verifyMedia } from '../../scripts/verify-media.mjs';
import type {} from './harness/main';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.mediaHarness);
});

test('browser codec capabilities are recorded explicitly', async ({ page, browser }, testInfo) => {
  const result = await page.evaluate(() => window.mediaHarness.capabilities());
  await testInfo.attach('capabilities.json', { body: JSON.stringify({ ...result, browserVersion: browser.version() }, null, 2), contentType: 'application/json' });
  expect(result.secureContext).toBe(true);
  expect(result.h264Encode, 'H.264 is required for the baseline').toBe(true);
  expect(result.opusEncode, 'Opus is required for the portable audio-encoding baseline').toBe(true);
});

test('generated H.264/AAC fixture matches independent frame and audio truth', async ({}, testInfo) => {
  const result = verifyMedia(path.join(fixtureDir, 'reference.mp4'), 'aac');
  await testInfo.attach('fixture-verification.json', { body: JSON.stringify(result), contentType: 'application/json' });
  await testInfo.attach('manifest.json', { body: await readFile(path.join(fixtureDir, 'manifest.json')), contentType: 'application/json' });
});

test('independent verifier rejects a duplicated frame even when frame count matches', async ({}, testInfo) => {
  const broken = testInfo.outputPath('duplicate-frame.mp4');
  ffmpeg([
    '-i', path.join(fixtureDir, 'reference.mp4'),
    '-filter_complex', '[0:v]split[a][b];[a][b]freezeframes=first=150:last=150:replace=149[v]',
    '-map', '[v]', '-map', '0:a:0', '-c:v', 'libx264', '-threads', '2', '-crf', '18', '-c:a', 'copy', broken,
  ]);
  expect(Number(probe(broken).streams.find((s: { codec_type: string }) => s.codec_type === 'video').nb_read_frames)).toBe(truth.frames);
  expect(() => verifyMedia(broken, 'aac')).toThrow('Frame identity mismatch at output frame 150');
});

test('browser reads MP4 metadata and seeks across keyframes in both directions', async ({ page }) => {
  const indices = [0, 157, 29, 299, 1, 30, 240];
  const result = await page.evaluate(times => window.mediaHarness.inspect('/reference.mp4', times), indices.map(i => (i + 0.25) / truth.fps));
  expect(result).toMatchObject({ width: 320, height: 180, videoCodec: 'avc', audioCodec: 'aac', sampleRate: 48000, channels: 2, videoCanDecode: true, audioCanDecode: true });
  expect(result.scannedDuration).toBeCloseTo(truth.duration, 2);
  expect(result.frames.map(f => f.id)).toEqual(indices);
  for (const frame of result.frames) {
    expect(Math.abs(frame.timestamp - frame.id / truth.fps)).toBeLessThan(0.000002);
  }
});

test('decoded MP3 length comes from samples despite a false Xing duration', async ({ page }, testInfo) => {
  const headerDuration = Number(probe(path.join(fixtureDir, 'wrong-duration.mp3')).format.duration);
  expect(Math.abs(headerDuration - truth.duration), 'Fixture must actually misreport its duration').toBeGreaterThan(2);
  const result = await page.evaluate(() => window.mediaHarness.decodeAudio('/wrong-duration.mp3'));
  await testInfo.attach('audio-duration.json', { body: JSON.stringify({ headerDuration, expectedDuration: truth.duration, ...result }, null, 2), contentType: 'application/json' });
  expect(result.durationSource).toBe('decoded-samples');
  expect(result.channels).toBe(2);
  expect(result.sampleRate).toBe(48000);
  expect(Math.abs(result.duration - truth.duration)).toBeLessThan(0.05);
  for (let c = 0; c < 2; c++) {
    expect(result.pulseStarts[c]).toHaveLength(truth.pulses[c].length);
    for (let i = 0; i < truth.pulses[c].length; i++) {
      expect(Math.abs(result.pulseStarts[c][i] - truth.pulses[c][i])).toBeLessThanOrEqual(0.025);
    }
  }
});

const modes = ['copy-aac', 'encode-opus'] as const;
for (const mode of modes) {
  test(`MP4 round trip: re-encode all video frames, audio=${mode}`, async ({ page }, testInfo) => {
    const [download, result] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(mode => window.mediaHarness.roundTrip('/reference.mp4', mode), mode),
    ]);
    expect(result.videoFrames).toBe(truth.frames);
    if (mode === 'encode-opus') expect(result.audioSamples).toBeGreaterThan(0);
    const outputPath = testInfo.outputPath('roundtrip.mp4');
    await download.saveAs(outputPath);
    const verified = verifyMedia(outputPath, mode === 'copy-aac' ? 'aac' : 'opus');
    await testInfo.attach('roundtrip.mp4', { path: outputPath, contentType: 'video/mp4' });
    await testInfo.attach('verification.json', { body: JSON.stringify({ adapter: result, verification: verified }), contentType: 'application/json' });
  });
}

// Explicit optional target. Never silently skip an unavailable AAC encoder.
if (process.env.TEST_NATIVE_AAC === '1') {
  test('native AAC: MP4 round trip with H.264 and AAC re-encoding', async ({ page }, testInfo) => {
    const capabilities = await page.evaluate(() => window.mediaHarness.capabilities());
    expect(capabilities.aacEncode, 'This browser/OS must provide a native AAC encoder for this target').toBe(true);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(() => window.mediaHarness.roundTrip('/reference.mp4', 'encode-aac')),
    ]);
    const output = testInfo.outputPath('native-aac.mp4');
    await download.saveAs(output);
    const verified = verifyMedia(output, 'aac');
    await testInfo.attach('verification.json', { body: JSON.stringify(verified), contentType: 'application/json' });
  });
}
