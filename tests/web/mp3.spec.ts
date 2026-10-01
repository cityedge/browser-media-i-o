import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ffmpeg, fixtureDir, truth } from '../../scripts/generate-fixtures.mjs';
import type {} from './harness/mp3';

function inspect(file: string) {
  return JSON.parse(execFileSync(process.env.FFPROBE_PATH || 'ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ], { encoding: 'utf8' }));
}
function verify(file: string, sampleRate: number, channels: number, duration: number) {
  const info = inspect(file), audio = info.streams[0];
  expect(info.streams).toHaveLength(1);
  expect(audio.codec_name).toBe('mp3');
  expect(Number(audio.sample_rate)).toBe(sampleRate);
  expect(audio.channels).toBe(channels);
  // Lamejs does not emit gapless metadata; bound encoder delay + frame padding explicitly.
  const tolerance = 2304 / sampleRate;
  expect(Math.abs(Number(info.format.duration) - duration)).toBeLessThanOrEqual(tolerance);
  const pcm = ffmpeg(['-i', file, '-f', 'f32le', '-c:a', 'pcm_f32le', 'pipe:1']);
  const sampleCount = pcm.length / 4 / channels;
  expect(Math.abs(sampleCount / sampleRate - duration)).toBeLessThanOrEqual(tolerance);
  return { info, pcm, sampleCount, duration: Number(info.format.duration) };
}

function matchMonoPcm(output: Buffer, wav: string) {
  const reference = ffmpeg(['-i', wav, '-f', 'f32le', '-c:a', 'pcm_f32le', 'pipe:1']);
  let best = Infinity;
  // Find encoder delay independently instead of baking in LAME's current delay value.
  for (let lag = 0; lag <= 2304; lag++) {
    let error = 0, energy = 0;
    const length = Math.min(reference.length / 4, output.length / 4 - lag);
    for (let i = 0; i < length; i += 37) {
      const expected = reference.readFloatLE(i * 4), actual = output.readFloatLE((i + lag) * 4);
      error += (actual - expected) ** 2; energy += expected ** 2;
    }
    if (energy > 0) best = Math.min(best, error / energy);
  }
  expect(best, 'Decoded MP3 should preserve the input waveform after encoder delay').toBeLessThan(.02);
}

async function start(page: Page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const counters = window.mp3Workers = { active: 0, started: 0 };
    window.Worker = class extends NativeWorker {
      alive = true;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options); counters.active++; counters.started++;
      }
      terminate() { if (this.alive) { counters.active--; this.alive = false; } super.terminate(); }
    };
    for (const key of ['MediaRecorder', 'AudioEncoder', 'VideoEncoder', 'AudioContext', 'OfflineAudioContext']) {
      Object.defineProperty(window, key, { value: undefined, configurable: true });
    }
    HTMLMediaElement.prototype.play = () => { throw new Error('MP3 export must not play media.'); };
  });
  await page.goto('/mp3.html');
  await page.waitForFunction(() => !!window.mp3Harness);
}

test('MP3: existing WAV becomes an offline stereo MP3 without playback or WebCodecs', async ({ page, context, browser }, testInfo) => {
  await start(page);
  const wav = await readFile(path.join(fixtureDir, 'reference.wav'));
  await context.setOffline(true);
  const [download, result] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(async base64 => {
      const progress: number[] = [];
      const source = new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'audio/wav' });
      const blob = await window.mp3Harness.wavToMp3(source, { onProgress: f => progress.push(f) });
      window.mp3Harness.save(blob);
      return { type: blob.type, size: blob.size, progress, workers: window.mp3Workers };
    }, wav.toString('base64')),
  ]);
  const output = testInfo.outputPath('stereo.mp3'); await download.saveAs(output);
  const checked = verify(output, 48000, 2, 10);
  expect(Number(checked.info.streams[0].bit_rate)).toBe(192000);
  expect(result.type).toBe('audio/mpeg'); expect(result.size).toBeLessThan(wav.length / 5);
  expect(result.workers).toEqual({ active: 0, started: 1 });
  expect(result.progress[0]).toBe(0); expect(result.progress.at(-1)).toBe(1);
  expect(result.progress).toEqual([...result.progress].sort((a, b) => a - b));
  const pulses: number[][] = [[], []];
  for (let c = 0; c < 2; c++) {
    let active = false;
    const bin = 240;
    for (let offset = 0; offset + bin <= checked.sampleCount; offset += bin) {
      let sum = 0;
      for (let i = offset; i < offset + bin; i++) sum += checked.pcm.readFloatLE((i * 2 + c) * 4) ** 2;
      const next = Math.sqrt(sum / bin) > .1;
      if (next && !active) pulses[c].push(offset / 48000);
      active = next;
    }
    expect(pulses[c]).toHaveLength(truth.pulses[c].length);
    for (let i = 0; i < pulses[c].length; i++) expect(Math.abs(pulses[c][i] - truth.pulses[c][i])).toBeLessThanOrEqual(.03);
  }
  await testInfo.attach('verification.json', { body: JSON.stringify({ browser: browser.version(), ...result, duration: checked.duration, sampleCount: checked.sampleCount, pulses }), contentType: 'application/json' });
});

test('MP3: AudioBuffer input preserves PCM and flushes a partial final frame', async ({ page }, testInfo) => {
  await start(page);
  const [download, result] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(async () => {
      const length = 44100 + 317;
      const audio = new AudioBuffer({ numberOfChannels: 1, sampleRate: 44100, length });
      const samples = audio.getChannelData(0);
      for (let i = 0; i < length; i++) samples[i] = .5 * Math.sin(2 * Math.PI * 440 * i / 44100);
      const before = samples.slice();
      const blob = await window.mp3Harness.encodeMp3(audio, { bitrate: 128000 });
      window.mp3Harness.save(blob);
      return { unchanged: samples.every((v, i) => v === before[i]), length: samples.length, workers: window.mp3Workers };
    }),
  ]);
  const output = testInfo.outputPath('mono.mp3'); await download.saveAs(output);
  const { pcm } = verify(output, 44100, 1, (44100 + 317) / 44100);
  expect(result).toMatchObject({ unchanged: true, length: 44417, workers: { active: 0 } });
  // The last real samples must still contain the tone, not silently lose the partial block.
  let sum = 0;
  for (let i = 44000; i < 44417; i++) sum += pcm.readFloatLE(i * 4) ** 2;
  expect(Math.sqrt(sum / 417)).toBeGreaterThan(.2);
});

for (const format of ['pcm_u8', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_f64le']) {
  test(`MP3: WAV format ${format} including extended headers`, async ({ page }, testInfo) => {
    const wav = testInfo.outputPath(`${format}.wav`);
    ffmpeg(['-i', path.join(fixtureDir, 'reference.wav'), '-t', '1.5', '-ar', '44100', '-ac', '1', '-c:a', format, wav]);
    await start(page);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(async bytes => {
        const blob = await window.mp3Harness.wavToMp3(new Uint8Array(bytes).buffer);
        window.mp3Harness.save(blob);
      }, [...await readFile(wav)]),
    ]);
    const output = testInfo.outputPath('converted.mp3'); await download.saveAs(output);
    const { pcm } = verify(output, 44100, 1, 1.5);
    matchMonoPcm(pcm, wav);
    let max = 0;
    for (let i = 0; i < pcm.length; i += 4) max = Math.max(max, Math.abs(pcm.readFloatLE(i)));
    expect(max).toBeGreaterThan(.2); expect(max).toBeLessThan(1);
  });
}

for (const sampleRate of [8000, 11025, 12000, 16000, 22050, 24000, 32000]) {
  test(`MP3: ${sampleRate} Hz PCM uses a supported default bitrate`, async ({ page }, testInfo) => {
    await start(page);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(async sampleRate => {
        const samples = Float32Array.from({ length: sampleRate + 17 }, (_, i) => .3 * Math.sin(2 * Math.PI * 440 * i / sampleRate));
        const blob = await window.mp3Harness.encodeMp3({ sampleRate, numberOfChannels: 1, length: samples.length, getChannelData: () => samples });
        window.mp3Harness.save(blob);
      }, sampleRate),
    ]);
    const output = testInfo.outputPath('rate.mp3'); await download.saveAs(output);
    verify(output, sampleRate, 1, (sampleRate + 17) / sampleRate);
  });
}

test('MP3: cancellation releases the worker, progress stays responsive, and retry works', async ({ page }, testInfo) => {
  await start(page);
  const result = await page.evaluate(async () => {
    const { encodeMp3 } = window.mp3Harness;
    const samples = new Float32Array(48000 * 60);
    const audio = { length: samples.length, sampleRate: 48000, numberOfChannels: 1, getChannelData: () => samples };
    const pre = new AbortController(); pre.abort();
    const code = (error: unknown) => (error as { code: string }).code;
    const before = await encodeMp3(audio, { signal: pre.signal }).then(() => 'unexpected', code);
    const controller = new AbortController();
    let ticks = 0, count = 0;
    const timer = setInterval(() => ticks++, 1);
    const during = await encodeMp3(audio, { signal: controller.signal, onProgress: value => {
      count++; if (value > .01) controller.abort();
    } }).then(() => 'unexpected', code);
    clearInterval(timer);
    const after = { ...window.mp3Workers };
    const short = { ...audio, length: 48000, getChannelData: () => samples.subarray(0, 48000) };
    const blob = await encodeMp3(short);
    return { before, during, after, count, ticks, retrySize: blob.size, workers: window.mp3Workers };
  });
  expect(result.before).toBe('ABORTED'); expect(result.during).toBe('ABORTED');
  expect(result.ticks).toBeGreaterThan(0); expect(result.count).toBeGreaterThan(1);
  expect(result.after).toEqual({ active: 0, started: 1 }); expect(result.workers).toEqual({ active: 0, started: 2 });
  expect(result.retrySize).toBeGreaterThan(0);
  await testInfo.attach('cancellation.json', { body: JSON.stringify(result), contentType: 'application/json' });
});

test('MP3: malformed inputs, unsupported settings and size limits reject without worker leaks', async ({ page }) => {
  await start(page);
  const bytes = (await readFile(path.join(fixtureDir, 'reference.wav'))).toString('base64');
  const result = await page.evaluate(async base64 => {
    const { encodeMp3, wavToMp3 } = window.mp3Harness;
    const wav = Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer;
    const audio = { sampleRate: 48000, numberOfChannels: 1, length: 48000, getChannelData: () => new Float32Array(48000) };
    const checks: Record<string, string> = {};
    const check = async (name: string, job: () => Promise<Blob>) => {
      checks[name] = await job().then(() => 'unexpected', e => e.code);
    };
    await check('truncated', () => wavToMp3(wav.slice(0, 50)));
    await check('notWav', () => wavToMp3(new Blob(['not wav'])));
    await check('inputLimit', () => wavToMp3(new Blob([wav]), { maxInputBytes: 10 }));
    await check('outputLimit', () => encodeMp3(audio, { maxOutputBytes: 10 }));
    await check('channels', () => encodeMp3({ ...audio, numberOfChannels: 3 }));
    await check('rate', () => encodeMp3({ ...audio, sampleRate: 96000 }));
    await check('empty', () => encodeMp3({ ...audio, length: 0 }));
    await check('bitrate', () => encodeMp3(audio, { bitrate: 123000 }));
    await check('nan', () => encodeMp3({ ...audio, getChannelData: () => new Float32Array(48000).fill(NaN) }));
    await check('callback', () => encodeMp3(audio, { onProgress: () => { throw new Error('app callback failed'); } }));
    return { checks, workers: window.mp3Workers };
  }, bytes);
  expect(result.checks).toEqual({ truncated: 'INVALID_ARGUMENT', notWav: 'INVALID_ARGUMENT', inputLimit: 'RESOURCE_LIMIT', outputLimit: 'RESOURCE_LIMIT', channels: 'UNSUPPORTED', rate: 'UNSUPPORTED', empty: 'INVALID_ARGUMENT', bitrate: 'INVALID_ARGUMENT', nan: 'INVALID_ARGUMENT', callback: 'ENCODE_FAILED' });
  expect(result.workers.active).toBe(0);
});

test('MP3: ordinary script demo switches WAV/MP3 and invalidates the old download', async ({ page, context }, testInfo) => {
  await start(page);
  await page.goto('/mp3-demo/index.html');
  await context.setOffline(true);
  await page.getByRole('button', { name: 'ファイルを作成' }).click();
  await expect(page.locator('#download')).toBeVisible();
  const mp3Download = page.waitForEvent('download'); await page.locator('#download').click();
  const mp3 = await mp3Download; expect(mp3.suggestedFilename()).toBe('sample.mp3');
  const mp3Path = testInfo.outputPath('sample.mp3'); await mp3.saveAs(mp3Path);
  verify(mp3Path, 48000, 1, 3);
  await page.locator('#format').selectOption('wav'); await expect(page.locator('#download')).toBeHidden();
  await page.getByRole('button', { name: 'ファイルを作成' }).click();
  await expect(page.locator('#download')).toBeVisible();
  const wavDownload = page.waitForEvent('download'); await page.locator('#download').click();
  const wav = await wavDownload; expect(wav.suggestedFilename()).toBe('sample.wav');
  const wavPath = testInfo.outputPath('sample.wav'); await wav.saveAs(wavPath);
  expect(inspect(wavPath).streams[0]).toMatchObject({ codec_name: 'pcm_s16le', sample_rate: '48000', channels: 1 });
  expect(await page.evaluate(() => window.mp3Workers)).toEqual({ active: 0, started: 1 });
});
