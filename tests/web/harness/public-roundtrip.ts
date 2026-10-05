// This entire import graph must work without loading the strict input adapter.
import { openMedia, createMp4Writer, type Mp4Writer } from 'browser-media-io/public';
import { enableAacFallback } from 'browser-media-io/aac';

export async function publicRoundtrip(blob: Blob) {
  const input = await openMedia(blob);
  let writer: Mp4Writer | undefined;
  try {
    const info = await input.probe();
    const backend = await enableAacFallback({ width: 320, height: 180 });
    // Exercise cancellation and reuse within this Window/Worker before the full export.
    const controller = new AbortController();
    const cancelled = input.audioPcmBlocks({ signal: controller.signal });
    await cancelled.next(); controller.abort(); await cancelled.return();
    writer = await createMp4Writer({ width: 320, height: 180, fps: 30, videoBitrate: 1_000_000,
      audio: { sampleRate: 48000, channels: 2 } });
    const canvas = new OffscreenCanvas(320, 180), context = canvas.getContext('2d')!;
    for await (const frame of input.videoFrames()) {
      try { frame.draw(context); await writer.addVideoFrame(canvas); }
      finally { frame.close(); }
    }
    for await (const block of input.audioPcmBlocks({ end: 10 })) await writer.addPcm(block);
    const result = await writer.finish();
    return { result, info, backend, audioBufferAvailable: typeof AudioBuffer !== 'undefined' };
  } finally {
    input.close();
    if (writer && writer.state !== 'finished') await writer.cancel();
  }
}
