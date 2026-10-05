// Test the actual extracted ZIP over file://, offline, without a web server or security overrides.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { archive } from './local-archive.mjs';
import { verifyMedia, probe } from './verify-media.mjs';
import { ffmpeg } from './generate-fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || (!existsSync(chromium.executablePath()) && existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browserName = /msedge/i.test(executablePath ?? '') ? 'edge' : /chrome/i.test(executablePath ?? '') ? 'chrome' : 'chromium';
const output = path.join(root, `tests/tmp/local-${browserName}`);
await mkdir(output, { recursive: true });
const extracted = await mkdtemp(path.join(output, '日本語 空白 ZIP展開-'));
const zip = path.join(root, `output/releases/browser-media-io-browser-${version}.zip`);
const report = { status: 'failed', testedAt: new Date().toISOString(), offline: true, browserName,
  cases: [], network: [], errors: [] };
let browser;
try {
  archive('unpack', zip, extracted);
  report.zipSha256 = createHash('sha256').update(await readFile(zip)).digest('hex');
  const sums = (await readFile(path.join(extracted, 'SHA256SUMS'), 'utf8')).trim().split('\n');
  for (const line of sums) {
    const [digest, name] = line.split('  ');
    assert.equal(createHash('sha256').update(await readFile(path.join(extracted, name))).digest('hex'), digest, name);
  }
  report.verifiedFiles = sums.length;
  const fixture = path.join(output, '入力 動画.mp4');
  await cp(path.join(root, 'tests/fixtures/generated/reference.mp4'), fixture);
  browser = await chromium.launch({ executablePath, headless: true });
  const watchdog = setTimeout(() => { void browser?.close(); }, 180000);
  watchdog.unref();
  report.browser = browser.version();
  report.platform = process.platform;
  for (const forceWasm of [false, true]) {
    const mode = forceWasm ? 'wasm' : 'native';
    const context = await browser.newContext({ offline: true, acceptDownloads: true, viewport: { width: 1200, height: 1000 } });
    context.on('request', request => { if (/^(https?|wss?):/.test(request.url())) report.network.push(request.url()); });
    // Exercise the real bundled fallback by changing only the native AAC capability response.
    if (forceWasm) await context.addInitScript(() => {
      const original = AudioEncoder.isConfigSupported.bind(AudioEncoder);
      AudioEncoder.isConfigSupported = config => config.codec.startsWith('mp4a')
        ? Promise.resolve({ supported: false, config }) : original(config);
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
    await page.goto(pathToFileURL(path.join(extracted, 'examples/local/index.html')).href);
    assert.equal(await page.title(), 'Browser Media I/O — Local');
    assert.equal(await page.evaluate(() => location.protocol), 'file:');
    await expect(page.locator('h1')).toContainText('ファイル');
    await page.locator('#language').selectOption('en');
    await expect(page.locator('h1')).toHaveText('Open. Convert. Save.');
    await page.locator('#language').selectOption('ja');
    await page.locator('#source').setInputFiles(fixture);
    await expect(page.locator('#export-mp4')).toBeEnabled();
    await expect(page.locator('#preview')).toBeVisible();
    for (const format of ['mp4', 'mp3']) {
      await page.locator('#export-' + format).click();
      await expect(page.locator('#save-' + format)).toBeVisible({ timeout: 90000 });
      await expect(page.locator('#error')).toBeHidden();
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#save-' + format).click()]);
      assert.equal(download.suggestedFilename(), `入力 動画-converted.${format}`);
      const target = path.join(output, `${mode}.${format}`);
      await download.saveAs(target);
      assert.equal(await download.failure(), null);
      assert.ok((await stat(target)).size > 0);
      if (format === 'mp4') {
        const { ffprobe: _info, ...media } = verifyMedia(target, 'aac', { pulseTolerance: 0.03 });
        report.cases.push({ mode, format, ...media });
      } else {
        const media = probe(target), track = media.streams.find(t => t.codec_type === 'audio');
        assert.equal(track.codec_name, 'mp3'); assert.equal(track.channels, 2);
        assert.ok(Math.abs(Number(media.format.duration) - 10) < 0.1);
        report.cases.push({ mode, format, codec: track.codec_name, duration: Number(media.format.duration) });
      }
    }
    const diagnostics = JSON.parse(await page.locator('#diagnostics').textContent());
    assert.equal(diagnostics.aacBackend, mode);
    report.cases.push({ mode, capabilities: diagnostics.capabilities, aacBackend: diagnostics.aacBackend });
    if (!forceWasm) {
      await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#language').selectOption('en');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
      await page.locator('#export-mp4').click();
      await page.locator('#cancel').click();
      await expect(page.locator('#status')).toHaveText('Cancelled. You can try again.');
      await expect(page.locator('#save-mp4')).toBeHidden();
      await page.locator('#export-mp4').click();
      await expect(page.locator('#save-mp4')).toBeVisible({ timeout: 90000 });
      await page.locator('#source').setInputFiles({ name: '壊れた.mp4', mimeType: 'video/mp4', buffer: Buffer.from('invalid') });
      await expect(page.locator('#error')).toBeVisible();
      await expect(page.locator('#save-mp4')).toBeHidden();
      await expect(page.locator('#save-mp3')).toBeHidden();
      // Audio-only input, real WAV selection and generated-background MP4.
      await page.locator('#source').setInputFiles(path.join(root, 'tests/fixtures/generated/reference.wav'));
      await expect(page.locator('#export-mp4')).toBeEnabled();
      await page.locator('#export-mp4').click();
      await expect(page.locator('#save-mp4')).toBeVisible({ timeout: 90000 });
      await expect(page.locator('#error')).toBeHidden();
      const delayed = path.join(output, '音声 遅延.mp4');
      ffmpeg(['-i', fixture, '-itsoffset', '0.25', '-i', fixture, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', delayed]);
      await page.locator('#source').setInputFiles(delayed);
      await expect(page.locator('#export-mp4')).toBeEnabled();
      await page.locator('#export-mp4').click();
      await expect(page.locator('#save-mp4')).toBeVisible({ timeout: 90000 });
      const delayedDownload = page.waitForEvent('download');
      await page.locator('#save-mp4').click();
      const delayedOutput = path.join(output, 'delayed-output.mp4');
      await (await delayedDownload).saveAs(delayedOutput);
      const firstPulse = file => {
        const pcm = ffmpeg(['-i', file, '-map', '0:a:0', '-af', 'aresample=48000:first_pts=0', '-ac', '2', '-f', 'f32le', 'pipe:1']);
        for (let i = 0; i < pcm.length / 8 - 240; i += 240) {
          let energy = 0;
          for (let j = i; j < i + 240; j++) energy += pcm.readFloatLE(j * 8) ** 2;
          if (Math.sqrt(energy / 240) > 0.1) return i / 48000;
        }
        throw new Error('Missing audio pulse');
      };
      const offsetError = Math.abs(firstPulse(delayed) - firstPulse(delayedOutput));
      assert.ok(offsetError <= 0.005);
      report.cases.push({ cancellationAndRetry: 'passed', invalidInput: 'passed', audioOnly: 'passed', delayedAudioErrorSeconds: offsetError, languages: ['ja', 'en'], viewports: ['1200x1000', '390x844'] });
    }
    // Public bundle runs alone in a fresh page, retaining its graph separation.
    const publicHtml = path.join(extracted, 'public-test.html');
    await writeFile(publicHtml, '<!doctype html><meta charset="utf-8"><input type="file" id="source"><script src="./browser-media-io-public.js"></script>');
    const publicPage = await context.newPage();
    publicPage.on('pageerror', error => report.errors.push(error.message));
    await publicPage.goto(pathToFileURL(publicHtml).href);
    await publicPage.locator('#source').setInputFiles(fixture);
    const result = await publicPage.evaluate(async () => {
      const api = window.BrowserMediaIOPublic;
      const input = await api.openMedia(document.getElementById('source').files[0]);
      try {
        const reader = input.videoFrames({ end: 1 });
        const first = await reader.next(); first.value.close(); await reader.return();
        const frame = await input.getVideoFrame(5); const timestamp = frame.timestamp; frame.close();
        const backend = await api.enableAacFallback({ width: 320, height: 180 });
        const writer = await api.createMp4Writer({ width: 320, height: 180, fps: 30, audio: { sampleRate: 48000, channels: 2 } });
        const canvas = new OffscreenCanvas(320, 180);
        canvas.getContext('2d').fillRect(0, 0, 320, 180);
        for (let i = 0; i < 30; i++) {
          await writer.addVideoFrame(canvas);
          await writer.addPcm({ sampleRate: 48000, numberOfChannels: 2, length: 1600, channelData: [new Float32Array(1600), new Float32Array(1600)] });
        }
        const output = await writer.finish();
        const decoded = await api.openMedia(output.blob);
        let frames = 0, samples = 0;
        try {
          for await (const frame of decoded.videoFrames()) { frames++; frame.close(); }
          for await (const block of decoded.audioPcmBlocks({ end: 1 })) samples += block.length;
        } finally { decoded.close(); }
        const mp3 = await api.encodeMp3({ sampleRate: 48000, numberOfChannels: 1, length: 48000, getChannelData: () => new Float32Array(48000) });
        return { timestamp, backend, frames, samples, mp3Bytes: mp3.size, strictGlobalAbsent: !window.BrowserMediaIO };
      } finally { input.close(); }
    });
    assert.equal(result.timestamp, 5); assert.equal(result.backend, mode);
    assert.equal(result.frames, 30); assert.equal(result.samples, 48000);
    assert.ok(result.mp3Bytes > 0 && result.strictGlobalAbsent);
    report.cases.push({ mode, publicBundle: result });
    await context.close();
  }
  assert.deepEqual(report.network, []); assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
