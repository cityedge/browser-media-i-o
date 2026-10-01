import { fail } from '../errors.js';

export interface PcmSource {
  sampleRate: number;
  channels: number;
  length: number;
  read(offset: number, count: number): Float32Array<ArrayBuffer>[];
}

/** Parse uncompressed little-endian RIFF/WAVE, without Web Audio or resampling. */
export function readWav(buffer: ArrayBuffer): PcmSource {
  const view = new DataView(buffer);
  const text = (offset: number, length: number) => String.fromCharCode(...new Uint8Array(buffer, offset, length));
  const invalid = (message: string): never => fail('INVALID_ARGUMENT', `Invalid WAV: ${message}`);
  if (buffer.byteLength < 12 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') {
    invalid('expected a RIFF/WAVE file.');
  }
  const end = view.getUint32(4, true) + 8;
  if (end < 12 || end > buffer.byteLength) invalid('truncated RIFF data.');
  let format: { tag: number; channels: number; sampleRate: number; bits: number; align: number } | undefined;
  let data: { offset: number; size: number } | undefined;
  for (let offset = 12; offset < end;) {
    if (offset + 8 > end) invalid('truncated chunk header.');
    const kind = text(offset, 4), size = view.getUint32(offset + 4, true), start = offset + 8;
    if (start + size > end) invalid('chunk extends past RIFF data.');
    if (kind === 'fmt ') {
      if (format || size < 16) invalid('missing or repeated format.');
      let tag = view.getUint16(start, true);
      const channels = view.getUint16(start + 2, true), sampleRate = view.getUint32(start + 4, true);
      const align = view.getUint16(start + 12, true), bits = view.getUint16(start + 14, true);
      if (tag === 0xfffe) {
        if (size < 40 || view.getUint16(start + 16, true) < 22) invalid('truncated extensible format.');
        const tail = [0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
        if (tail.some((byte, i) => view.getUint8(start + 28 + i) !== byte)) {
          fail('UNSUPPORTED', 'Unsupported WAV subformat.');
        }
        tag = view.getUint32(start + 24, true);
        const validBits = view.getUint16(start + 18, true), mask = view.getUint32(start + 20, true);
        if (validBits !== 0 && validBits !== bits) fail('UNSUPPORTED', 'Packed valid-bit WAV is not supported.');
        if (mask && !((channels === 1 && mask === 4) || (channels === 2 && mask === 3))) {
          fail('UNSUPPORTED', 'Only mono or left/right stereo WAV is supported.');
        }
      }
      if (!((tag === 1 && [8, 16, 24, 32].includes(bits)) || (tag === 3 && [32, 64].includes(bits)))) {
        fail('UNSUPPORTED', 'WAV must contain integer PCM (8/16/24/32 bit) or float PCM (32/64 bit).');
      }
      if (![1, 2].includes(channels)) fail('UNSUPPORTED', 'MP3 export supports mono and stereo only.');
      if (align !== channels * bits / 8 || !sampleRate || view.getUint32(start + 8, true) !== sampleRate * align) {
        invalid('inconsistent PCM format.');
      }
      format = { tag, channels, sampleRate, bits, align };
    } else if (kind === 'data') {
      if (data) fail('UNSUPPORTED', 'Multiple WAV data chunks are not supported.');
      data = { offset: start, size };
    }
    // Unknown chunks (LIST, JUNK, fact, ...) and their padding are preserved in the traversal.
    offset = start + size + (size & 1);
    if (offset > end) invalid('missing chunk padding.');
  }
  if (!format || !data) return invalid('fmt or data chunk is missing.');
  const { tag, channels, sampleRate, bits, align } = format;
  const { offset: dataOffset, size } = data;
  if (!size || size % align) invalid('empty or incomplete PCM frames.');
  return {
    sampleRate, channels, length: size / align,
    read(offset, count) {
      return Array.from({ length: channels }, (_, channel) => {
        const samples = new Float32Array(count);
        for (let i = 0; i < count; i++) {
          const pos = dataOffset + (offset + i) * align + channel * bits / 8;
          let value: number;
          if (tag === 3) value = bits === 32 ? view.getFloat32(pos, true) : view.getFloat64(pos, true);
          else if (bits === 8) value = (view.getUint8(pos) - 128) / 128;
          else if (bits === 16) value = view.getInt16(pos, true) / 32768;
          else if (bits === 24) {
            const integer = view.getUint8(pos) | (view.getUint8(pos + 1) << 8) | (view.getInt8(pos + 2) << 16);
            value = integer / 8388608;
          } else value = view.getInt32(pos, true) / 2147483648;
          samples[i] = value;
        }
        return samples;
      });
    },
  };
}
