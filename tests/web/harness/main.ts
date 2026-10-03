// Tests consume the built package through its public exports, just like an application.
import { getCapabilities, openMedia, probe, decodeAudio, renderMp4, createMp4Writer, frameTime, MediaError,
  type ExportProgress, type PositionedWrite } from 'browser-media-io';
import { enableAacFallback } from 'browser-media-io/aac';
import { twoVideos, grayRoundtrip, croppedUpload } from './gpu';
import { measureReads, longExport } from './performance';

async function file(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fixture request failed: ${response.status} ${url}`);
  return response.blob();
}
async function capabilities() {
  return { adapter: 'browser-media-io@0.2.0', userAgent: navigator.userAgent,
    ...await getCapabilities({ width: 320, height: 180, videoBitrate: 1_000_000 }) };
}
function identify(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) {
  const pixels = context.getImageData(0, 0, 320, 180).data;
  let id = 0;
  for (let bit = 0; bit < 10; bit++) if (pixels[(32 * 320 + 16 + bit * 24 + 12) * 4] > 128) id |= 1 << bit;
  return id;
}
function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
async function inspect(url: string, times: number[]) {
  const input = await openMedia(await file(url));
  try {
    const info = await input.probe();
    const video = info.tracks.find(t => t.kind === 'video')!, audio = info.tracks.find(t => t.kind === 'audio')!;
    const canvas = new OffscreenCanvas(320, 180), context = canvas.getContext('2d', { willReadFrequently: true })!;
    const frames = [];
    for (const time of times) {
      const frame = await input.getVideoFrame(time);
      if (!frame) throw new Error(`No frame at ${time}`);
      try { frame.draw(context); frames.push({ requested: time, timestamp: frame.timestamp, duration: frame.duration, id: identify(context) }); }
      finally { frame.close(); }
    }
    return { metadataDuration: video.metadataDuration, scannedDuration: info.duration.seconds,
      width: video.video!.width, height: video.video!.height, videoCodec: video.codec, audioCodec: audio.codec,
      sampleRate: audio.audio!.sampleRate, channels: audio.audio!.channels, videoCanDecode: video.canDecode, audioCanDecode: audio.canDecode, frames };
  } finally { input.close(); }
}
function pulseStarts(buffer: AudioBuffer) {
  return Array.from({ length: buffer.numberOfChannels }, (_, c) => {
    const values = buffer.getChannelData(c), bin = Math.round(buffer.sampleRate * 0.005), starts: number[] = [];
    let active = false;
    for (let offset = 0; offset < values.length; offset += bin) {
      const end = Math.min(offset + bin, values.length);
      let sum = 0;
      for (let i = offset; i < end; i++) sum += values[i] ** 2;
      const next = Math.sqrt(sum / (end - offset)) > 0.1;
      if (next && !active) starts.push(offset / buffer.sampleRate);
      active = next;
    }
    return starts;
  });
}
async function readAudio(url: string) {
  const { buffer, ...result } = await decodeAudio(await file(url));
  return { ...result, pulseStarts: pulseStarts(buffer) };
}
async function roundTrip(url: string, mode: 'encode-opus' | 'encode-aac' | 'native-aac') {
  const blob = await file(url);
  const input = await openMedia(blob);
  const audio = await decodeAudio(blob);
  let backend = 'native';
  if (mode === 'encode-aac') backend = await enableAacFallback({ width: 320, height: 180 });
  const progress: ExportProgress[] = [];
  try {
    const result = await renderMp4({ width: 320, height: 180, fps: 30, duration: 10, videoBitrate: 1_000_000,
      audio: audio.buffer, audioCodec: mode === 'encode-opus' ? 'opus' : 'aac',
      onProgress: item => progress.push(item),
      renderFrame: async (context, time) => {
        const frame = await input.getVideoFrame(time);
        if (!frame) throw new Error(`Missing frame at ${time}`);
        try { frame.draw(context); } finally { frame.close(); }
      },
    });
    save(result.blob!, `${mode}.mp4`);
    return { ...result, blob: undefined, audioMode: mode, backend, progress };
  } finally { input.close(); }
}

const harness = { capabilities, inspect, decodeAudio: readAudio, roundTrip, twoVideos, grayRoundtrip, croppedUpload, measureReads, longExport,
  api: { getCapabilities, openMedia, probe, decodeAudio, renderMp4, createMp4Writer, frameTime, MediaError, enableAacFallback }, file,
  async synthetic(streaming: boolean) {
    const audio = await decodeAudio(await file('/reference.wav'));
    await enableAacFallback({ width: 320, height: 180 });
    let handle: FileSystemFileHandle | undefined;
    if (streaming) handle = await (await navigator.storage.getDirectory()).getFileHandle('test-export.mp4', { create: true });
    const stream = handle ? await handle.createWritable() : undefined;
    const result = await renderMp4({ width: 320, height: 180, fps: 30, duration: 10, audio: audio.buffer, videoBitrate: 1_000_000,
      target: stream ? { kind: 'stream', stream: stream as WritableStream<PositionedWrite> } : { kind: 'blob' },
      renderFrame: (ctx, _time, n) => {
        ctx.fillStyle = '#333'; ctx.fillRect(0, 0, 320, 180);
        for (let bit = 0; bit < 10; bit++) { ctx.fillStyle = (n >> bit) & 1 ? '#ebebeb' : '#101010'; ctx.fillRect(16 + bit * 24, 16, 24, 32); }
      },
    });
    save(handle ? await handle.getFile() : result.blob!, 'synthetic.mp4');
    return { ...result, blob: undefined, streamed: result.blob === null };
  },
};
declare global { interface Window { mediaHarness: typeof harness } }
window.mediaHarness = harness;
