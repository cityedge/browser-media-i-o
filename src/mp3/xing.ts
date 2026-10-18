import { checkAbort, fail } from '../errors.js';

/** Add a metadata-only MPEG frame, without copying the encoded audio. Counts exclude
 * this frame; byte size and the 100-entry seek table include it (Xing convention).
 * No LAME quality/settings or gapless metadata is invented here. */
export async function xingHeader(parts: readonly Uint8Array[], size: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  function reader() {
    let chunk = 0, start = 0;
    return (at: number) => {
      while (chunk < parts.length && at >= start + parts[chunk].length) start += parts[chunk++].length;
      if (chunk >= parts.length || at < start) fail('ENCODE_FAILED', 'Invalid MP3 frame offset.');
      return parts[chunk][at - start];
    };
  }
  const first = reader();
  const header = [first(0), first(1), first(2), first(3)];
  const version = (header[1] >> 3) & 3, high = version === 3;
  const sampleRate = [44100, 48000, 32000][(header[2] >> 2) & 3] / (high ? 1 : version === 2 ? 2 : 4);
  const mono = (header[3] >> 6) === 3;
  const side = high ? (mono ? 17 : 32) : (mono ? 9 : 17);
  const factor = high ? 144000 : 72000;
  const tagSize = Math.floor(factor * 64 / sampleRate);
  if (!sampleRate || version === 1 || tagSize < 4 + side + 116) fail('ENCODE_FAILED', 'Unsupported MP3 frame for Xing metadata.');
  if (size + tagSize > 0xffffffff) fail('RESOURCE_LIMIT', 'MP3 exceeds the Xing size field.');
  const tag = new Uint8Array(tagSize);
  tag.set(header);
  tag[1] |= 1; // no CRC on the metadata frame
  tag[2] = ((high ? 5 : 8) << 4) | (header[2] & 0x0c); // 64 kbps, no padding
  const xing = 4 + side, view = new DataView(tag.buffer);
  tag.set([88, 105, 110, 103], xing); // Xing
  view.setUint32(xing + 4, 7); // frame count, byte count, seek table
  view.setUint32(xing + 12, size + tagSize);
  const bitrates = high ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]
    : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
  function frameSize(byte: ReturnType<typeof reader>, at: number) {
    const a = byte(at), b = byte(at + 1), c = byte(at + 2);
    const rate = bitrates[c >> 4];
    if (a !== 255 || (b & 0xfe) !== (header[1] & 0xfe) || (c & 0x0c) !== (header[2] & 0x0c) || !rate) {
      fail('ENCODE_FAILED', 'Invalid MP3 frame while building Xing metadata.');
    }
    return Math.floor(factor * rate / sampleRate) + ((c >> 1) & 1);
  }
  async function yieldIfNeeded(frames: number) {
    if (frames % 8192 === 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      checkAbort(signal);
    }
  }
  // Two sequential header scans use constant auxiliary memory, even for long audio.
  let frames = 0, at = 0, byte = reader();
  while (at < size) {
    at += frameSize(byte, at); frames++;
    if (frames % 8192 === 0) await yieldIfNeeded(frames);
  }
  if (at !== size || !frames) fail('ENCODE_FAILED', 'Truncated MP3 output.');
  view.setUint32(xing + 8, frames);
  at = 0; byte = reader();
  let point = 1;
  for (let frame = 0; frame < frames; frame++) {
    while (point < 100 && Math.floor(frames * point / 100) === frame) {
      tag[xing + 16 + point++] = Math.min(255, Math.floor(256 * (tagSize + at) / (tagSize + size)));
    }
    at += frameSize(byte, at);
    if ((frame + 1) % 8192 === 0) await yieldIfNeeded(frame + 1);
  }
  checkAbort(signal);
  return tag;
}
