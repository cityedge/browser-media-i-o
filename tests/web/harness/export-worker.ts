import { exportTwoVideos } from '../../../examples/worker-export';
import { createMp4Writer, openMedia } from 'browser-media-io';
import { enableAacFallback } from 'browser-media-io/aac';

addEventListener('message', async (event: MessageEvent) => {
  try {
    const options = event.data;
    let workerProbePackets;
    if (options.cancelFirst) {
      const input = await openMedia(options.left), readController = new AbortController();
      const reader = input.audioPcmBlocks({ signal: readController.signal });
      try {
        await reader.next(); readController.abort(); await reader.return();
        workerProbePackets = (await input.probe()).tracks.find(t => t.kind === 'video')?.packetCount;
      } finally { await reader.return(); input.close(); }
      await enableAacFallback({ width: 320, height: 180 });
      const controller = new AbortController();
      const writer = await createMp4Writer({ width: 320, height: 180, fps: 30, signal: controller.signal,
        audio: { sampleRate: 48000, channels: 2 } });
      const canvas = new OffscreenCanvas(320, 180); canvas.getContext('2d')!.fillRect(0, 0, 320, 180);
      await writer.addVideoFrame(canvas);
      const pending = writer.addPcm({ sampleRate: 48000, numberOfChannels: 2, length: 1600,
        channelData: [new Float32Array(1600), new Float32Array(1600)] }).then(() => 'done', e => e.code);
      controller.abort(); await writer.cancel();
      const code = await pending;
      if (code !== 'ABORTED') throw new Error(`Worker cancellation failed: ${code}`);
    }
    const result = await exportTwoVideos(options);
    postMessage({ result, workerProbePackets, audioBufferAvailable: typeof AudioBuffer !== 'undefined' });
  } catch (error) { postMessage({ error: String(error), stack: (error as Error).stack }); }
});
