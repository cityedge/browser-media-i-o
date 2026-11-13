import { checkAbort } from './errors.js';
import { copyFail } from './video-copy-errors.js';

type Box = { type: string; start: number; body: number; end: number };
const ascii = (b: Uint8Array, at: number) => String.fromCharCode(...b.subarray(at, at + 4));
/** Validate structures the demuxer's public API cannot report without silently normalizing them. */
export async function inspectCopyContainer(file: Blob, trackId: number, signal: AbortSignal) {
  const read = async (at: number, size: number) => {
    checkAbort(signal);
    if (size < 0 || size > 64 * 1024 * 1024 || at + size > file.size) copyFail('LIMIT', 'Invalid or oversized MP4 metadata.', 'RESOURCE_LIMIT');
    const b = new Uint8Array(await file.slice(at, at + size).arrayBuffer()); checkAbort(signal); return b;
  };
  const boxes = async (start: number, end: number): Promise<Box[]> => {
    const result: Box[] = [];
    for (let at = start; at < end;) {
      if (at + 8 > end) copyFail('CONTAINER', 'Truncated MP4 box.');
      const h = await read(at, Math.min(16, end - at)), v = new DataView(h.buffer);
      let size = v.getUint32(0), header = 8;
      if (size === 1) { if (h.length < 16) copyFail('CONTAINER', 'Truncated extended box.'); size = Number(v.getBigUint64(8)); header = 16; }
      else if (size === 0) size = end - at;
      if (!Number.isSafeInteger(size) || size < header || at + size > end) copyFail('CONTAINER', 'Invalid MP4 box size.');
      result.push({ type: ascii(h, 4), start: at, body: at + header, end: at + size });
      if (result.length > 100000) copyFail('LIMIT', 'Too many MP4 boxes.', 'RESOURCE_LIMIT');
      at += size;
    }
    return result;
  };
  const one = (list: Box[], type: string) => {
    const found = list.filter(x => x.type === type);
    if (found.length !== 1) copyFail('CONTAINER', `Expected one ${type} box.`);
    return found[0];
  };
  const top = await boxes(0, file.size);
  if (top.some(x => ['moof', 'sidx'].includes(x.type))) copyFail('CONTAINER', 'Fragmented MP4 is not supported for video copy.');
  one(top, 'ftyp'); const moov = one(top, 'moov'), movie = await boxes(moov.body, moov.end);
  if (movie.some(x => x.type === 'mvex')) copyFail('CONTAINER', 'Fragmented MP4 is not supported.');
  const mvhd = one(movie, 'mvhd'), mh = await read(mvhd.body, Math.min(32, mvhd.end - mvhd.body));
  const movieScale = new DataView(mh.buffer).getUint32(mh[0] === 1 ? 20 : 12);
  let selected: Box[] | undefined;
  for (const trak of movie.filter(x => x.type === 'trak')) {
    const children = await boxes(trak.body, trak.end), tkhd = one(children, 'tkhd');
    const h = await read(tkhd.body, Math.min(32, tkhd.end - tkhd.body));
    if (new DataView(h.buffer).getUint32(h[0] === 1 ? 20 : 12) === trackId) selected = children;
  }
  if (!selected) copyFail('CONTAINER', 'Selected video track was not found.');
  let editDuration: number | null = null;
  const edts = selected.find(x => x.type === 'edts');
  if (edts) {
    const elst = one(await boxes(edts.body, edts.end), 'elst'), b = await read(elst.body, elst.end - elst.body), v = new DataView(b.buffer);
    const count = v.getUint32(4), stride = b[0] === 1 ? 20 : 12;
    if (b[0] > 1 || count < 1 || count > 2 || b.length !== 8 + count * stride) copyFail('TIMELINE', 'Multiple/invalid MP4 edits are unsupported.');
    for (let i = 0; i < count; i++) {
      const at = 8 + i * stride, duration = b[0] === 1 ? Number(v.getBigUint64(at)) : v.getUint32(at);
      const time = b[0] === 1 ? Number(v.getBigInt64(at + 8)) : v.getInt32(at + 4);
      if (v.getInt16(at + stride - 4) !== 1 || v.getInt16(at + stride - 2) !== 0
        || time < -1 || (time === -1 ? i !== 0 || count !== 2 : i !== count - 1)) copyFail('TIMELINE', 'Only one unit-rate media edit with optional initial empty edit is supported.');
      if (time !== -1) editDuration = duration / movieScale;
    }
  }
  const mdia = one(selected, 'mdia'), media = await boxes(mdia.body, mdia.end), minf = one(media, 'minf');
  const stbl = one(await boxes(minf.body, minf.end), 'stbl'), table = await boxes(stbl.body, stbl.end);
  if (table.some(x => ['senc', 'saiz', 'saio', 'sgpd', 'sbgp'].includes(x.type))) copyFail('CONTAINER', 'Encryption/sample groups are unsupported.');
  const stsd = one(table, 'stsd'), sh = await read(stsd.body, 8);
  if (new DataView(sh.buffer).getUint32(4) !== 1) copyFail('CONFIGURATION_CHANGE', 'Multiple sample descriptions are unsupported.');
  const entries = await boxes(stsd.body + 8, stsd.end);
  const entry = one(entries, 'avc1');
  const fields = await boxes(entry.body + 78, entry.end);
  let pixelAspectRatio: { num: number; den: number } | undefined;
  for (const field of fields) {
    if (!['avcC', 'pasp', 'colr', 'btrt', 'fiel'].includes(field.type)) copyFail('DISPLAY_METADATA', `Unsupported video sample metadata: ${field.type}.`);
    if (field.type === 'colr') {
      const c = await read(field.body, field.end - field.body), v = new DataView(c.buffer);
      if (!['nclx', 'nclc'].includes(ascii(c, 0)) || c.length < 10) copyFail('DISPLAY_METADATA', 'ICC color profiles are unsupported.');
      if (![1, 2, 5, 6, 9].includes(v.getUint16(4)) || ![1, 2, 6, 13, 14, 15, 16, 18].includes(v.getUint16(6))
        || ![0, 1, 2, 5, 6, 9].includes(v.getUint16(8))) copyFail('DISPLAY_METADATA', 'Unsupported color interpretation.');
    }
    if (field.type === 'fiel') { const f = await read(field.body, 2); if (f[0] !== 1) copyFail('DISPLAY_METADATA', 'Interlaced display metadata is unsupported.'); }
    if (field.type === 'pasp') {
      const p = await read(field.body, 8), v = new DataView(p.buffer);
      pixelAspectRatio = { num: v.getUint32(0), den: v.getUint32(4) };
      if (!pixelAspectRatio.num || !pixelAspectRatio.den) copyFail('DISPLAY_METADATA', 'Invalid pixel aspect ratio.');
    }
  }
  one(fields, 'avcC');
  const stsc = one(table, 'stsc'), sc = await read(stsc.body, stsc.end - stsc.body), sv = new DataView(sc.buffer);
  const count = sv.getUint32(4);
  if (sc.length !== 8 + count * 12) copyFail('CONTAINER', 'Invalid sample-to-chunk table.');
  for (let i = 0; i < count; i++) if (sv.getUint32(16 + i * 12) !== 1) copyFail('CONFIGURATION_CHANGE', 'Sample description changes are unsupported.');
  return { editDuration, movieScale, pixelAspectRatio };
}
