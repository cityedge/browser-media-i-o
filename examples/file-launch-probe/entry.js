import { createMp4Writer, openMedia, getCapabilities } from 'browser-media-io/public';
import { enableAacFallback } from 'browser-media-io/aac';
import { wavToMp3 } from 'browser-media-io/mp3';
// Development probe, not the final standalone library distribution.
window.verifyRelease = async () => {
  const capabilities = await getCapabilities({ width: 320, height: 180 });
  const backend = await enableAacFallback({ width: 320, height: 180, sampleRate: 48000, channels: 2 });
  const writer = await createMp4Writer({ width: 320, height: 180, fps: 30, audio: { sampleRate: 48000, channels: 2 } });
  const canvas = new OffscreenCanvas(320, 180), ctx = canvas.getContext('2d');
  for (let n = 0; n < 30; n++) {
    ctx.fillStyle = '#0080ff'; ctx.fillRect(0, 0, 320, 180);
    await writer.addVideoFrame(canvas);
    await writer.addPcm({ sampleRate: 48000, numberOfChannels: 2, length: 1600, channelData: [new Float32Array(1600), new Float32Array(1600)] });
  }
  const result = await writer.finish(), input = await openMedia(result.blob);
  window.outputMp4 = result.blob;
  let frames = 0, samples = 0;
  try {
    for await (const frame of input.videoFrames()) { frames++; frame.close(); }
    for await (const block of input.audioPcmBlocks({ end: 1 })) samples += block.length;
  } finally { input.close(); }
  const data = new ArrayBuffer(44 + 48000 * 2), view = new DataView(data);
  function ascii(offset, text) { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); }
  ascii(0, 'RIFF'); view.setUint32(4, data.byteLength - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 48000, true); view.setUint32(28, 96000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, data.byteLength - 44, true);
  for (let i = 0; i < 48000; i++) view.setInt16(44 + i * 2, Math.round(15000 * Math.sin(i / 48000 * Math.PI * 880)), true);
  const wav = new Blob([data]), packedMp3 = await wavToMp3(wav), standaloneMp3 = await window.BrowserMp3.wavToMp3(wav);
  window.outputMp3 = packedMp3;
  const a = new Uint8Array(await packedMp3.arrayBuffer()), b = new Uint8Array(await standaloneMp3.arrayBuffer());
  if (frames !== 30 || samples !== 48000 || !a.length || a.length !== b.length || a.some((v, i) => v !== b[i])) throw new Error('Packaged media roundtrip failed');
  return { frames, samples, mp4Bytes: result.blob.size, mp3Bytes: a.length, identicalStandaloneMp3: true, backend, capabilities };
};

window.readSelectedFile = async () => {
  const file = document.querySelector('#source').files[0];
  if (!file) throw new Error('生成済みreference.mp4を選択してください。');
  const input = await openMedia(file);
  try {
    const info = await input.probe();
    const frame = await input.getVideoFrame(5);
    try { return { packets: info.tracks.find(t => t.kind === 'video').packetCount, timestamp: frame?.timestamp ?? null }; }
    finally { frame?.close(); }
  } finally { input.close(); }
};

const report = document.querySelector('#result');
async function show(job) {
  report.textContent = '処理中…';
  try { report.textContent = JSON.stringify(await job(), null, 2); }
  catch (error) { report.textContent = String(error); }
}
document.querySelector('#read').addEventListener('click', () => show(window.readSelectedFile));
document.querySelector('#convert').addEventListener('click', () => show(window.verifyRelease));
for (const format of ['mp4', 'mp3']) document.querySelector('#save-' + format).addEventListener('click', () => {
  const blob = format === 'mp4' ? window.outputMp4 : window.outputMp3;
  if (!blob) { report.textContent = '先に入出力チェックを実行してください。'; return; }
  const link = document.createElement('a'), url = URL.createObjectURL(blob);
  link.href = url; link.download = 'local-output.' + format; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
