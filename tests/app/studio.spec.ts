import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixtureDir, ffmpeg } from '../../scripts/generate-fixtures.mjs';
import { probe, verifyMedia } from '../../scripts/verify-media.mjs';

const file = (name: string) => path.join(fixtureDir, name);
async function ready(page: Page) {
  await expect(page.getByRole('status', { name: '処理状況' })).toContainText('読み込み完了');
  await expect(page.getByRole('button', { name: 'MP4を書き出す' })).toBeEnabled();
}
async function seekTo(page: Page, time: number) {
  await page.locator('#seek').fill(String(time));
  await expect(page.locator('#time')).toHaveText(`0:${time.toFixed(3).padStart(6, '0')}`);
}
async function downloadOutput(page: Page, destination: string) {
  await page.getByRole('button', { name: 'MP4を書き出す' }).click();
  await expect(page.getByRole('status', { name: '処理状況' })).toContainText('書き出し完了', {
    timeout: 60_000,
  });
  const pending = page.waitForEvent('download');
  await page.getByRole('link', { name: 'MP4をダウンロード' }).click();
  await (await pending).saveAs(destination);
}
async function subtitlePixels(page: Page) {
  return page.locator('#preview').evaluate((element: HTMLCanvasElement) => {
    const data = element
      .getContext('2d')!
      .getImageData(0, element.height * 0.8, element.width, element.height * 0.2).data;
    let white = 0;
    for (let i = 0; i < data.length; i += 4)
      if (data[i] > 210 && data[i + 1] > 210 && data[i + 2] > 210) white++;
    return white;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#diagnostics')).toContainText('h264Encode');
});

test('MP4 file picker → rapid seeks → AAC export preserves all 300 frames and audio timing', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('#visual').setInputFiles(file('reference.mp4'));
  await ready(page);
  await expect(page.locator('#sound-info')).toContainText('動画の音声を使用');
  await page.locator('#size').selectOption('320x180');
  await expect(page.locator('#duration')).toHaveValue('10');
  await page.locator('#seek').evaluate((input: HTMLInputElement) => {
    for (const at of [9.99, 1, 8, 0, 3, 5.24]) {
      input.value = String(at);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await expect(page.locator('#time')).toHaveText('0:05.240');
  const id = await page.locator('#preview').evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d')!;
    let value = 0;
    for (let bit = 0; bit < 10; bit++)
      if (context.getImageData(16 + bit * 24 + 12, 32, 1, 1).data[0] > 128) value |= 1 << bit;
    return value;
  });
  expect(id).toBe(157);
  const destination = testInfo.outputPath('app-roundtrip.mp4');
  await downloadOutput(page, destination);
  const result = verifyMedia(destination, 'aac', { pulseTolerance: 0.005 });
  await testInfo.attach('app-roundtrip-verification.json', {
    body: JSON.stringify(result),
    contentType: 'application/json',
  });
  await page.locator('summary').click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '評価レポートを保存' }).click();
  const reportPath = testInfo.outputPath('report.json');
  await (await pending).saveAs(reportPath);
  const reportText = await readFile(reportPath, 'utf8'),
    report = JSON.parse(reportText);
  expect(report.output.videoFrames).toBe(300);
  expect(report.outputProbe.tracks.find((t: { kind: string }) => t.kind === 'video').packetCount).toBe(300);
  expect(reportText).not.toContain('reference.mp4');
  expect(errors).toEqual([]);
});

test('image + false-duration MP3 + SRT uses decoded length and burns captions at the right times', async ({
  page,
}, testInfo) => {
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#283850';
    ctx.fillRect(0, 0, 320, 180);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page
    .locator('#visual')
    .setInputFiles({ name: 'still.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
  await ready(page);
  await page.locator('#sound').setInputFiles(file('wrong-duration.mp3'));
  await ready(page);
  await expect(page.locator('#duration')).toHaveValue('10');
  await expect(page.locator('#sound-info')).toContainText('480,000 samples');
  await expect(page.locator('#sound-info')).toContainText('ヘッダーは5.016 秒');
  await page.locator('#duration').fill('1.1');
  await page.locator('#srt-file').setInputFiles({
    name: 'captions.srt',
    mimeType: 'text/plain',
    buffer: Buffer.from('\uFEFF1\r\n00:00:00,200 --> 00:00:00,700\r\nTest subtitle\r\n'),
  });
  await ready(page);
  await expect(page.locator('#duration')).toHaveValue('1.1');
  await page.locator('#size').selectOption('320x180');
  await page.locator('#duration').fill('1.1');
  await seekTo(page, 0.35);
  expect(await subtitlePixels(page)).toBeGreaterThan(60);
  await seekTo(page, 0.9);
  expect(await subtitlePixels(page)).toBe(0);
  await seekTo(page, 0.35);
  await page.screenshot({ path: testInfo.outputPath('image-audio-subtitles.png'), fullPage: true });
  const destination = testInfo.outputPath('captions.mp4');
  await downloadOutput(page, destination);
  const info = probe(destination);
  expect(
    Number(info.streams.find((s: { codec_type: string }) => s.codec_type === 'video').nb_read_frames),
  ).toBe(33);
  expect(info.streams.find((s: { codec_type: string }) => s.codec_type === 'audio').codec_name).toBe('aac');
  const whites = (at: number) => {
    const frame = ffmpeg([
      '-ss',
      String(at),
      '-i',
      destination,
      '-frames:v',
      '1',
      '-pix_fmt',
      'gray',
      '-f',
      'rawvideo',
      'pipe:1',
    ]);
    return [...frame.subarray(320 * 144)].filter((value) => value > 210).length;
  };
  expect(whites(0.35)).toBeGreaterThan(60);
  expect(whites(0.9)).toBe(0);
});

test('delayed MP4 audio keeps its original offset and the last video frame is held', async ({
  page,
}, testInfo) => {
  const delayed = testInfo.outputPath('delayed-input.mp4');
  ffmpeg([
    '-i',
    file('reference.mp4'),
    '-itsoffset',
    '0.25',
    '-i',
    file('reference.mp4'),
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c',
    'copy',
    delayed,
  ]);
  await page.locator('#visual').setInputFiles(delayed);
  await ready(page);
  await page.locator('#size').selectOption('320x180');
  const destination = testInfo.outputPath('delayed-output.mp4');
  await downloadOutput(page, destination);
  const firstPulse = (media: string) => {
    const pcm = ffmpeg([
      '-i',
      media,
      '-map',
      '0:a:0',
      '-af',
      'aresample=48000:first_pts=0',
      '-ac',
      '2',
      '-f',
      'f32le',
      'pipe:1',
    ]);
    for (let i = 0; i < pcm.length / 8 - 240; i += 240) {
      let sum = 0;
      for (let j = i; j < i + 240; j++) sum += pcm.readFloatLE(j * 8) ** 2;
      if (Math.sqrt(sum / 240) > 0.1) return i / 48000;
    }
    throw new Error('Expected pulse not found');
  };
  const original = firstPulse(delayed),
    output = firstPulse(destination);
  expect(original).toBeGreaterThan(1.2);
  expect(Math.abs(output - original)).toBeLessThanOrEqual(0.005);
  const info = probe(destination);
  expect(
    Number(info.streams.find((s: { codec_type: string }) => s.codec_type === 'video').nb_read_frames),
  ).toBeGreaterThan(300);
  const last = ffmpeg([
    '-ss',
    '10.1',
    '-i',
    destination,
    '-frames:v',
    '1',
    '-pix_fmt',
    'gray',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
  let id = 0;
  for (let bit = 0; bit < 10; bit++) if (last[32 * 320 + 16 + bit * 24 + 12] > 128) id |= 1 << bit;
  expect(id).toBe(299);
});

test('demo can be cancelled, exported again, played and invalidated after a setting change', async ({
  page,
}, testInfo) => {
  await page.getByRole('button', { name: 'サンプルを試す' }).click();
  await ready(page);
  await page.getByRole('button', { name: 'プレビュー再生', exact: true }).click();
  await expect(page.locator('#time')).not.toHaveText('0:00.000');
  await page.getByRole('button', { name: 'プレビュー停止' }).click();
  await page.getByRole('button', { name: 'MP4を書き出す' }).click();
  await page.getByRole('button', { name: '中止する' }).click();
  await expect(page.getByRole('status', { name: '処理状況' })).toContainText('書き出しを中止しました');
  await expect(page.locator('#result')).toBeHidden();
  await page.locator('#size').selectOption('320x180');
  await page.locator('#duration').fill('1');
  const destination = testInfo.outputPath('after-cancel.mp4');
  await downloadOutput(page, destination);
  expect(
    Number(
      probe(destination).streams.find((s: { codec_type: string }) => s.codec_type === 'video').nb_read_frames,
    ),
  ).toBe(30);
  await page.locator('#duration').fill('2');
  await expect(page.locator('#result')).toBeHidden();
  await expect(page.locator('#download')).not.toHaveAttribute('href');
});

test('invalid files and captions recover without losing loaded media; silent output is supported', async ({
  page,
}, testInfo) => {
  await page.locator('#visual').setInputFiles(file('reference.mp4'));
  await ready(page);
  await page
    .locator('#visual')
    .setInputFiles({ name: 'broken.mp4', mimeType: 'video/mp4', buffer: Buffer.from('not an MP4') });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('#visual-info')).toContainText('reference.mp4');
  await page.locator('#subtitles').fill('not SRT');
  await expect(page.getByRole('button', { name: 'MP4を書き出す' })).toBeDisabled();
  await page.locator('#subtitles').fill('');
  await expect(page.getByRole('button', { name: 'MP4を書き出す' })).toBeEnabled();
  await page.getByRole('button', { name: '背景を外す' }).click();
  await ready(page);
  await page.locator('#size').selectOption('320x180');
  await page.locator('#duration').fill('.5');
  const destination = testInfo.outputPath('silent.mp4');
  await downloadOutput(page, destination);
  const info = probe(destination);
  expect(info.streams).toHaveLength(1);
  expect(Number(info.streams[0].nb_read_frames)).toBe(15);
});

test('studio fits a narrow screen and the demo makes a useful initial preview', async ({
  page,
}, testInfo) => {
  await page.getByRole('button', { name: 'サンプルを試す' }).click();
  await ready(page);
  await seekTo(page, 1);
  await page.screenshot({ path: testInfo.outputPath('studio-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('studio-mobile.png'), fullPage: true });
});
