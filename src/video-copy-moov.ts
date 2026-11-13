// Finalize an exact presentation window while retaining AAC priming and encoded tail packets.
// fastStart:false puts moov last, so replacing it cannot move any media chunk offsets.
import { copyFail } from './video-copy-errors.js';
type Box = { type: string; bytes: Uint8Array<ArrayBuffer> };
function children(bytes: Uint8Array<ArrayBuffer>, offset = 8): Box[] {
  const out: Box[] = [], v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  while (offset < bytes.length) {
    const size = v.getUint32(offset);
    if (size < 8 || offset + size > bytes.length) copyFail('CONTAINER', 'Unexpected output moov structure.');
    out.push({ type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)), bytes: bytes.slice(offset, offset + size) }); offset += size;
  }
  return out;
}
function box(type: string, pieces: Uint8Array<ArrayBuffer>[]) {
  const size = 8 + pieces.reduce((n, p) => n + p.length, 0), b = new Uint8Array(size), v = new DataView(b.buffer);
  v.setUint32(0, size); b.set([...type].map(c => c.charCodeAt(0)), 4);
  let offset = 8; for (const p of pieces) { b.set(p, offset); offset += p.length; } return b;
}
function setDuration(b: Uint8Array<ArrayBuffer>, offset: number, value: number) {
  const v = new DataView(b.buffer, b.byteOffset, b.length);
  if (b[8] === 1) v.setBigUint64(offset, BigInt(value));
  else { if (value > 0xffffffff) copyFail('LIMIT', 'Output duration exceeds MP4 v0 header.', 'RESOURCE_LIMIT'); v.setUint32(offset, value); }
}
export function trimCopyMoov(data: Uint8Array, duration: number): Uint8Array<ArrayBuffer> {
  const items = children(data.slice()), mvhd = items.find(x => x.type === 'mvhd')!;
  if (!mvhd) copyFail('CONTAINER', 'Missing output movie header.');
  const movieView = new DataView(mvhd.bytes.buffer), scale = movieView.getUint32(mvhd.bytes[8] === 1 ? 28 : 20);
  const ticks = Math.round(duration * scale);
  setDuration(mvhd.bytes, mvhd.bytes[8] === 1 ? 32 : 24, ticks);
  for (const item of items.filter(x => x.type === 'trak')) {
    const track = children(item.bytes), tkhd = track.find(x => x.type === 'tkhd')!;
    setDuration(tkhd.bytes, tkhd.bytes[8] === 1 ? 36 : 28, ticks);
    const old = track.find(x => x.type === 'edts'); let mediaTime = 0n;
    if (old) {
      const elst = children(old.bytes).find(x => x.type === 'elst')?.bytes;
      if (!elst) copyFail('CONTAINER', 'Missing output edit list.');
      const v = new DataView(elst.buffer);
      if (v.getUint32(12) !== 1) copyFail('TIMELINE', 'Unexpected output edit list.');
      mediaTime = elst[8] === 1 ? v.getBigInt64(24) : BigInt(v.getInt32(20));
      if (mediaTime < 0) copyFail('TIMELINE', 'Unexpected output empty edit.');
    }
    const content = new Uint8Array(28), v = new DataView(content.buffer);
    content[0] = 1; v.setUint32(4, 1); v.setBigUint64(8, BigInt(ticks)); v.setBigInt64(16, mediaTime); v.setInt16(24, 1);
    const edts = box('edts', [box('elst', [content])]);
    if (old) old.bytes = edts; else track.splice(1, 0, { type: 'edts', bytes: edts });
    item.bytes = box('trak', track.map(x => x.bytes));
  }
  return box('moov', items.map(x => x.bytes));
}
