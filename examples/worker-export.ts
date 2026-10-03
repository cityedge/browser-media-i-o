import { openMedia, createMp4Writer, type PcmBlock, type PositionedWrite, type MediaInput, type MediaReader, type Mp4Writer } from 'browser-media-io';
import { enableAacFallback } from 'browser-media-io/aac';
import { WebGlFrameRenderer } from './webgl-frame.js';

/** Runs in either Window or Dedicated Worker. Worker creation/messages belong to the application. */
export async function exportTwoVideos(options: {
  left: Blob; right: Blob; audio: Blob; duration: number;
  canvasPath?: boolean; fileName?: string; signal?: AbortSignal;
}) {
  const width = 640, height = 180, fps = 30, sampleRate = 48000;
  const backend = await enableAacFallback({ width, height });
  const inputs: MediaInput[] = [], readers: MediaReader<unknown>[] = [];
  let renderer: WebGlFrameRenderer | undefined, writer: Mp4Writer | undefined;
  let stream: FileSystemWritableFileStream | undefined;
  try {
    const open = async (blob: Blob) => { const input = await openMedia(blob); inputs.push(input); return input; };
    const left = await open(options.left), right = await open(options.right), audio = await open(options.audio);
    const count = Math.round(options.duration * fps);
    const times = function* () { for (let n = 0; n < count; n++) yield n / fps; };
    const a = left.videoFramesAt(times(), { signal: options.signal }); readers.push(a);
    const b = right.videoFramesAt(times(), { signal: options.signal }); readers.push(b);
    const pcm = audio.audioPcmBlocks({ end: count / fps, maxBlockSamples: 4096, signal: options.signal }); readers.push(pcm);
    const canvas = new OffscreenCanvas(width, height); renderer = new WebGlFrameRenderer(canvas);
    const handle = options.fileName ? await (await navigator.storage.getDirectory()).getFileHandle(options.fileName, { create: true }) : undefined;
    stream = handle ? await handle.createWritable() : undefined;
    writer = await createMp4Writer({ width, height, fps, signal: options.signal, videoBitrate: 1_000_000,
      audio: { sampleRate, channels: 2 }, target: stream ? { kind: 'stream', stream: stream as WritableStream<PositionedWrite> } : undefined });
    let block: PcmBlock | undefined, offset = 0;
    const started = performance.now();
    for (let n = 0; n < count; n++) {
      const [x, y] = await Promise.all([a.next(), b.next()]);
      const lf = x.value?.frame, rf = y.value?.frame;
      try {
        if (!lf || !rf) throw new Error('This example expects continuous video starting at zero.');
        renderer.draw(lf, 0, 0, width / 2, height); renderer.draw(rf, width / 2, 0, width / 2, height);
        if (options.canvasPath) await writer.addVideoFrame(canvas);
        else {
          // Snapshot immediately after drawing, before any asynchronous work.
          const frame = new VideoFrame(canvas, { timestamp: Math.round(n / fps * 1e6) });
          try { await writer.addVideoFrame(frame); } finally { frame.close(); }
        }
      } finally { lf?.close(); rf?.close(); }
      const until = Math.round((n + 1) / fps * sampleRate);
      while (writer.audioSamples < until) {
        if (!block || offset === block.length) {
          const item = await pcm.next();
          if (item.done) throw new Error('The example expects audio covering the output duration.');
          block = item.value; offset = 0;
        }
        const length = Math.min(block.length - offset, until - writer.audioSamples);
        await writer.addPcm({ ...block, length, channelData: block.channelData.map(c => c.subarray(offset, offset + length)) });
        offset += length;
      }
    }
    const result = await writer.finish();
    return { ...result, blob: handle ? await handle.getFile() : result.blob!, backend,
      elapsedMs: performance.now() - started, webglRenderer: renderer.renderer };
  } finally {
    // Attempt all cleanup even if setup or one reader's return failed.
    const cleanup = await Promise.allSettled(readers.map(reader => reader.return()));
    for (const input of inputs) input.close();
    renderer?.close();
    if (writer && writer.state !== 'finished') await writer.cancel();
    else if (!writer && stream && !stream.locked) await stream.abort();
    const failure = cleanup.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
