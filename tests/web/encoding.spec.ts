import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import type { VideoEncodingOptions } from 'browser-media-io';
import type {} from './harness/main';

for (const entry of ['strict', 'public']) {
  test.describe(`H.264 rate control (${entry})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(entry === 'public' ? '/?input=public' : '/');
      await page.waitForFunction(() => !!window.mediaHarness);
    });

    test('invalid and conflicting settings fail before acquiring a stream', async ({ page }) => {
      const results = await page.evaluate(async () => {
        const api = window.mediaHarness.api;
        const invalid = [
          { videoBitrateMode: 'bad' }, { videoBitrate: 0 }, { videoHardwareAcceleration: 'bad' },
          { videoBitrateMode: 'quantizer' }, { videoBitrateMode: 'quantizer', videoQuantizer: -1 },
          { videoBitrateMode: 'quantizer', videoQuantizer: 52 },
          { videoBitrateMode: 'quantizer', videoQuantizer: 23.5 },
          { videoBitrateMode: 'quantizer', videoQuantizer: 23, videoBitrate: 20_000_000 },
          { videoBitrateMode: 'constant', videoQuantizer: 23 },
        ];
        const code = async (fn: () => Promise<unknown>) => {
          try { await fn(); return 'ok'; } catch (error) { return (error as { code: string }).code; }
        };
        const stream = new WritableStream();
        const results = [];
        for (const options of invalid) {
          const settings = options as VideoEncodingOptions;
          results.push([await code(() => api.getCapabilities(settings)),
            await code(() => api.createMp4Writer({ width: 320, height: 180, fps: 30, ...settings,
              target: { kind: 'stream', stream } })), stream.locked]);
        }
        return results;
      });
      expect(results).toHaveLength(9);
      for (const result of results) expect(result).toEqual(['INVALID_ARGUMENT', 'INVALID_ARGUMENT', false]);
    });

    for (const mode of ['variable', 'constant', 'quantizer'] as const) {
      test(`${mode}: supported output reaches the real encoder; unsupported settings reject`, async ({ page }, testInfo) => {
        const settings: VideoEncodingOptions = mode === 'quantizer'
          ? { videoBitrateMode: mode, videoQuantizer: 23, videoHardwareAcceleration: 'no-preference' }
          : { videoBitrateMode: mode, videoBitrate: 20_000_000, videoHardwareAcceleration: 'prefer-software' };
        const supported = await page.evaluate(settings => window.mediaHarness.api.getCapabilities({
          width: 640, height: 360, fps: 30, ...settings,
        }).then(c => c.h264Encode), settings);
        if (!supported) {
          const code = await page.evaluate(async settings => {
            try { await window.mediaHarness.api.createMp4Writer({ width: 640, height: 360, fps: 30, ...settings }); }
            catch (error) { return (error as { code: string }).code; }
            return 'ok';
          }, settings);
          expect(code).toBe('UNSUPPORTED');
          await testInfo.attach('unsupported.json', { body: JSON.stringify({ settings, supported }), contentType: 'application/json' });
          return;
        }
        const [download, result] = await Promise.all([
          page.waitForEvent('download'),
          page.evaluate(async settings => {
            const configs: VideoEncoderConfig[] = [], quantizers: (number | null | undefined)[] = [];
            const configure = VideoEncoder.prototype.configure, encode = VideoEncoder.prototype.encode;
            VideoEncoder.prototype.configure = function(config) { configs.push({ ...config }); return configure.call(this, config); };
            VideoEncoder.prototype.encode = function(frame, options) { quantizers.push(options?.avc?.quantizer); return encode.call(this, frame, options); };
            try {
              const result = await window.mediaHarness.api.renderMp4({ width: 640, height: 360, fps: 30, duration: 2, ...settings,
                renderFrame(ctx, time) {
                  ctx.fillStyle = '#132035'; ctx.fillRect(0, 0, 640, 360);
                  ctx.fillStyle = '#aaddff'; ctx.fillRect(time * 200, 80, 100, 200);
                },
              });
              const url = URL.createObjectURL(result.blob!);
              const link = document.createElement('a'); link.href = url; link.download = 'rate-control.mp4'; link.click();
              setTimeout(() => URL.revokeObjectURL(url), 10_000);
              return { ...result, blob: undefined, configs, quantizers };
            } finally { VideoEncoder.prototype.configure = configure; VideoEncoder.prototype.encode = encode; }
          }, settings),
        ]);
        expect(result.configs).toHaveLength(1);
        expect(result.configs[0]).toMatchObject({ bitrateMode: mode, hardwareAcceleration: settings.videoHardwareAcceleration, latencyMode: 'quality', framerate: 30 });
        if (mode === 'quantizer') {
          expect(result.configs[0].bitrate).toBeUndefined();
          expect(new Set(result.quantizers)).toEqual(new Set([23]));
          expect(result.videoBitrate).toBeNull();
        } else {
          expect(result.configs[0].bitrate).toBe(20_000_000);
          expect(result.videoBitrate).toBe(20_000_000);
          expect(result.videoQuantizer).toBeNull();
        }
        const file = testInfo.outputPath('rate-control.mp4'); await download.saveAs(file);
        const info = JSON.parse(execFileSync(process.env.FFPROBE_PATH || 'ffprobe', [
          '-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_streams', '-of', 'json', file,
        ], { encoding: 'utf8' }));
        const videoBytes = info.packets.reduce((sum: number, packet: { size: string }) => sum + Number(packet.size), 0);
        expect(info.packets).toHaveLength(60);
        expect(info.streams[0].codec_name).toBe('h264');
        expect(result.videoBytes).toBe(videoBytes);
        expect(result.averageVideoBitrate).toBe(videoBytes * 8 / 2);
        expect(result.videoBytes).toBeLessThan(result.bytes);
        expect(result.videoBitrateMode).toBe(mode);
        await testInfo.attach('rate-control.json', { body: JSON.stringify(result), contentType: 'application/json' });
      });
    }
  });
}

test('CBR capability failure does not fall back to VBR or acquire the destination', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => !!window.mediaHarness);
  const result = await page.evaluate(async () => {
    const original = VideoEncoder.isConfigSupported;
    VideoEncoder.isConfigSupported = async config => config.bitrateMode === 'constant'
      ? { supported: false, config } : original.call(VideoEncoder, config);
    const stream = new WritableStream();
    try {
      const options = { width: 322, height: 182, fps: 30, videoBitrateMode: 'constant' as const, videoBitrate: 19_000_001 };
      const supported = (await window.mediaHarness.api.getCapabilities(options)).h264Encode;
      try { await window.mediaHarness.api.createMp4Writer({ ...options, target: { kind: 'stream', stream } }); }
      catch (error) { return { supported, code: (error as { code: string }).code, locked: stream.locked }; }
      return { code: 'ok' };
    } finally { VideoEncoder.isConfigSupported = original; }
  });
  expect(result).toEqual({ supported: false, code: 'UNSUPPORTED', locked: false });
});
