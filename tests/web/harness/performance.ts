import { openMedia, createMp4Writer, type PositionedWrite } from 'browser-media-io';
import { enableAacFallback } from 'browser-media-io/aac';
import { exportTwoVideos } from '../../../examples/worker-export';

function statistics(values: number[]) {
  const sorted = values.slice().sort((a, b) => a - b);
  return { count: values.length, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * .95) - 1], values };
}
export async function measureReads() {
  const blob = await (await fetch('/reference.mp4')).blob();
  const cold = [];
  for (const time of [8, .9, 7.9, 1, 6, 2.9]) {
    const x = await openMedia(blob), y = await openMedia(blob);
    const left = x.videoFrames({ start: time }), right = y.videoFrames({ start: time });
    try {
      const started = performance.now(); let leftMs = 0, rightMs = 0;
      const [a, b] = await Promise.all([left.next().then(v => { leftMs = performance.now() - started; return v; }),
        right.next().then(v => { rightMs = performance.now() - started; return v; })]);
      cold.push({ time, leftMs, rightMs, pairedMs: performance.now() - started });
      a.value?.close(); b.value?.close();
    } finally { await left.return(); await right.return(); x.close(); y.close(); }
  }
  const a = await openMedia(blob), b = await openMedia(blob);
  const started = performance.now(), paired: number[] = [], left: number[] = [], right: number[] = [];
  let count = 0;
  const ar = a.videoFrames(), br = b.videoFrames();
  try {
    while (true) {
      const start = performance.now();
      const [x, y] = await Promise.all([ar.next().then(x => { left.push(performance.now() - start); return x; }),
        br.next().then(y => { right.push(performance.now() - start); return y; })]);
      if (x.done || y.done) { x.value?.close(); y.value?.close(); break; }
      paired.push(performance.now() - start);
      if (Math.abs(x.value.timestamp - y.value.timestamp) > .000001) throw new Error('Pair PTS mismatch');
      x.value.close(); y.value.close(); count++;
    }
  } finally { await ar.return(); await br.return(); }
  const decode = { elapsedMs: performance.now() - started, pairs: count, mediaSeconds: 10,
    left: statistics(left.slice(0, count)), right: statistics(right.slice(0, count)), paired: statistics(paired) };
  const seeks: { time: number; direction: string; nearKeyframe: boolean; leftMs: number; rightMs: number; pairedMs: number; abortToReadyMs: number }[] = [];
  let oldA = a.videoFrames(), oldB = b.videoFrames();
  for (const reader of [oldA, oldB]) (await reader.next()).value!.close();
  try {
    for (let n = 0; n < 24; n++) {
      const time = [8, .9, 7.9, 1, 6, 2.9][n % 6];
      const abortStart = performance.now(); await Promise.all([oldA.return(), oldB.return()]);
      const start = performance.now();
      oldA = a.videoFrames({ start: time }); oldB = b.videoFrames({ start: time });
      let leftMs = 0, rightMs = 0;
      const [x, y] = await Promise.all([oldA.next().then(x => { leftMs = performance.now() - start; return x; }),
        oldB.next().then(y => { rightMs = performance.now() - start; return y; })]);
      const pairedMs = performance.now() - start, abortToReadyMs = performance.now() - abortStart;
      if (!x.value || !y.value) throw new Error('Missing seek result');
      seeks.push({ time, direction: n === 0 ? 'initial' : time < seeks[n - 1].time ? 'backward' : 'forward',
        nearKeyframe: Number.isInteger(time), leftMs, rightMs, pairedMs, abortToReadyMs });
      x.value.close(); y.value.close();
    }
  } finally { await oldA.return(); await oldB.return(); a.close(); b.close(); }
  const exports = [];
  for (let n = 0; n < 3; n++) {
    const result = await exportTwoVideos({ left: blob, right: blob, audio: blob, duration: 10, fileName: 'performance.mp4' });
    exports.push({ elapsedMs: result.elapsedMs, bytes: result.bytes, backend: result.backend, webglRenderer: result.webglRenderer });
  }
  return { cold, coldSummary: statistics(cold.map(s => s.pairedMs)), decode, seeks, seekSummary: { left: statistics(seeks.map(s => s.leftMs)), right: statistics(seeks.map(s => s.rightMs)),
    paired: statistics(seeks.map(s => s.pairedMs)), abortToReady: statistics(seeks.map(s => s.abortToReadyMs)) }, exports,
    userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency };
}

export async function longExport(seconds: number) {
  const width = 320, height = 180, fps = 30, sampleRate = 48000, frames = seconds * fps;
  const backend = await enableAacFallback({ width, height });
  const handle = await (await navigator.storage.getDirectory()).getFileHandle('long-export.mp4', { create: true });
  const destination = await handle.createWritable(), sink = destination.getWriter();
  let writes = 0, activeWrites = 0, peakWrites = 0, largestWrite = 0;
  const stream = new WritableStream<PositionedWrite>({
    async write(command) {
      writes++; activeWrites++; peakWrites = Math.max(peakWrites, activeWrites); largestWrite = Math.max(largestWrite, command.data.length);
      try {
        // Slow the real save destination; writes must await it rather than queue indefinitely.
        await new Promise(resolve => setTimeout(resolve, 2)); await sink.write(command);
      } finally { activeWrites--; }
    },
    async close() { await sink.close(); sink.releaseLock(); },
    async abort(reason) { await sink.abort(reason); sink.releaseLock(); },
  });
  const writer = await createMp4Writer({ width, height, fps, videoBitrate: 500_000,
    audio: { sampleRate, channels: 2 }, target: { kind: 'stream', stream } });
  const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d')!;
  const length = sampleRate / fps, channels = [new Float32Array(length), new Float32Array(length)];
  const pulses = [[1, seconds / 2, seconds - 1], [2, seconds / 2 + 1, seconds - .5]];
  const memory: { frame: number; usedJSHeapBytes: number | null; writes: number; elapsedMs: number }[] = [];
  const started = performance.now();
  const record = (frame: number) => {
    const value = performance as Performance & { memory?: { usedJSHeapSize: number } };
    memory.push({ frame, usedJSHeapBytes: value.memory?.usedJSHeapSize ?? null, writes, elapsedMs: performance.now() - started });
    console.log(`LONG_EXPORT ${frame}/${frames} ${Math.round((performance.now() - started) / 1000)}s`);
  };
  record(0);
  try {
    for (let n = 0; n < frames; n++) {
      ctx.fillStyle = '#303030'; ctx.fillRect(0, 0, width, height);
      for (let bit = 0; bit < 16; bit++) {
        ctx.fillStyle = n >> bit & 1 ? '#ebebeb' : '#101010'; ctx.fillRect(16 + bit * 18, 16, 18, 32);
      }
      await writer.addVideoFrame(canvas);
      for (let c = 0; c < 2; c++) for (let i = 0; i < length; i++) {
        const t = (n * length + i) / sampleRate;
        let value = 0;
        for (const at of pulses[c]) {
          const local = t - at;
          if (local >= 0 && local < .1) value = .7 * Math.min(1, local / .005, (.1 - local) / .005) * Math.sin(2 * Math.PI * (c ? 600 : 1000) * local);
        }
        channels[c][i] = value;
      }
      await writer.addPcm({ sampleRate, numberOfChannels: 2, length, channelData: channels });
      if ((n + 1) % (fps * Math.min(60, seconds)) === 0) record(n + 1);
    }
    const beforeFinalizeMs = performance.now() - started;
    const result = await writer.finish(); record(frames);
    const blob = await handle.getFile(), url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = 'long-export.mp4'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { ...result, blob: undefined, backend, memory, pulses, writes, peakWrites, largestWrite,
      pcmBytes: channels.reduce((n, c) => n + c.byteLength, 0), heldCanvasCount: 1,
      beforeFinalizeMs, elapsedMs: performance.now() - started };
  } finally { if (writer.state !== 'finished') await writer.cancel(); }
}
