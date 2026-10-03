import { openMedia, createMp4Writer } from 'browser-media-io';
import { MediaFrame } from '../../../dist/input';
import { VideoSample } from 'mediabunny';
import { WebGlFrameRenderer } from '../../../examples/webgl-frame';
import { exportTwoVideos } from '../../../examples/worker-export';

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function get(url: string) { return (await fetch(url)).blob(); }
export async function twoVideos(worker: boolean, canvasPath: boolean) {
  const blob = await get('/reference.mp4');
  const options = { left: blob, right: blob, audio: blob, duration: 10, canvasPath,
    fileName: 'worker-test.mp4', cancelFirst: true };
  let data;
  if (worker) {
    const instance = new Worker(new URL('./export-worker.ts', import.meta.url), { type: 'module' });
    try {
      data = await new Promise<{ result: Awaited<ReturnType<typeof exportTwoVideos>>; audioBufferAvailable: boolean; workerProbePackets: number }>((resolve, reject) => {
        instance.onmessage = e => e.data.error ? reject(new Error(`${e.data.error}\n${e.data.stack}`)) : resolve(e.data);
        instance.onerror = e => reject(new Error(e.message)); instance.postMessage(options);
      });
    } finally { instance.terminate(); }
  } else data = { result: await exportTwoVideos(options), audioBufferAvailable: typeof AudioBuffer !== 'undefined', workerProbePackets: undefined };
  save(data.result.blob, 'two-videos.mp4');
  return { ...data, result: { ...data.result, blob: undefined } };
}
function sample2d(canvas: OffscreenCanvas) {
  const values: number[] = [], ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  for (const [x, y] of [[.1, .1], [.9, .1], [.1, .9], [.9, .9]]) values.push(ctx.getImageData(Math.floor(x * canvas.width), Math.floor(y * canvas.height), 1, 1).data[0]);
  return values;
}
export async function grayRoundtrip(canvasPath: boolean) {
  const results = [];
  for (const rotation of [0, 90, 180, 270]) for (const flip of [false, true]) {
    const input = await openMedia(await get(`/gray-${rotation}-${Number(flip)}.mp4`)), frame = (await input.getVideoFrame(0))!;
    const a = new OffscreenCanvas(frame.width, frame.height), ctx = a.getContext('2d', { willReadFrequently: true })!;
    frame.draw(ctx);
    const canvas = new OffscreenCanvas(frame.width, frame.height), renderer = new WebGlFrameRenderer(canvas);
    const writer = await createMp4Writer({ width: frame.width, height: frame.height, fps: 1, videoBitrate: 2_000_000 });
    try {
      renderer.draw(frame);
      const copy = new OffscreenCanvas(frame.width, frame.height), copyContext = copy.getContext('2d', { willReadFrequently: true })!;
      copyContext.drawImage(canvas, 0, 0);
      const drawn = ctx.getImageData(0, 0, a.width, a.height).data;
      const gpu = copyContext.getImageData(0, 0, a.width, a.height).data;
      let maxDifference = 0; for (let n = 0; n < drawn.length; n++) maxDifference = Math.max(maxDifference, Math.abs(drawn[n] - gpu[n]));
      const gray = [];
      // Locate original stripe centers after applying rotation then horizontal flip.
      for (const u of [.1, .3, .5, .7, .9]) {
        let x = u, y = .5;
        if (rotation === 90) [x, y] = [1 - y, x];
        if (rotation === 180) [x, y] = [1 - x, 1 - y];
        if (rotation === 270) [x, y] = [y, 1 - x];
        if (flip) x = 1 - x;
        gray.push({ x: Math.floor(x * canvas.width), y: Math.floor(y * canvas.height) });
      }
      const before = gray.map(p => copyContext.getImageData(p.x, p.y, 1, 1).data[0]);
      if (canvasPath) await writer.addVideoFrame(canvas);
      else { const native = new VideoFrame(canvas, { timestamp: 0 }); try { await writer.addVideoFrame(native); } finally { native.close(); } }
      const output = await writer.finish(), decoded = await openMedia(output.blob!);
      let after: number[];
      try {
        const f = (await decoded.getVideoFrame(0))!;
        try { f.draw(copyContext); after = gray.map(p => copyContext.getImageData(p.x, p.y, 1, 1).data[0]); }
        finally { f.close(); }
      } finally { decoded.close(); }
      results.push({ rotation: frame.rotation, flip: frame.flip, width: frame.width, height: frame.height,
        squarePixelWidth: frame.squarePixelWidth, squarePixelHeight: frame.squarePixelHeight,
        corners2d: sample2d(a), cornersGl: sample2d(copy), maxDifference, before, after, renderer: renderer.renderer });
    } finally { frame.close(); input.close(); renderer.close(); if (writer.state !== 'finished') await writer.cancel(); }
  }
  return results;
}

// Focused geometry test of VideoFrame.visibleRect; container tests above exercise real decoded inputs.
export function croppedUpload() {
  const base = new OffscreenCanvas(128, 128), ctx = base.getContext('2d')!;
  ctx.fillStyle = '#f00'; ctx.fillRect(0, 0, 128, 128); ctx.fillStyle = '#808080'; ctx.fillRect(32, 16, 64, 96);
  const native = new VideoFrame(base, { timestamp: 0, visibleRect: { x: 32, y: 16, width: 64, height: 96 }, displayWidth: 64, displayHeight: 96 });
  const sample = new VideoSample(native);
  // Test-only construction: the internal constructor is stripped from the public declaration.
  // @ts-expect-error MediaFrame is normally obtained through openMedia().
  const frame = new MediaFrame(sample, () => {});
  const canvas = new OffscreenCanvas(64, 96), renderer = new WebGlFrameRenderer(canvas);
  try {
    renderer.draw(frame);
    const copy = new OffscreenCanvas(64, 96), c = copy.getContext('2d')!; c.drawImage(canvas, 0, 0);
    return Array.from(c.getImageData(0, 0, 64, 96).data).filter((_, n) => n % 4 !== 3).reduce((max, v) => Math.max(max, Math.abs(v - 128)), 0);
  } finally { frame.close(); renderer.close(); }
}
