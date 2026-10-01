import { Mp3Encoder } from '@breezystack/lamejs';

// This module is bundled separately and runs only inside a dedicated Worker.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
let encoder: Mp3Encoder | undefined;
scope.onmessage = ({ data }) => {
  try {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    const append = (bytes: Uint8Array) => {
      if (bytes.length) chunks.push(new Uint8Array(bytes));
    };
    if (data.type === 'init') {
      encoder = new Mp3Encoder(data.channels, data.sampleRate, data.bitrate / 1000);
    } else if (data.type === 'encode') {
      if (!encoder) throw new Error('Encoder is not initialized.');
      const channels = (data.channels as Float32Array[]).map(channel => {
        const pcm = new Int16Array(channel.length);
        for (let i = 0; i < channel.length; i++) {
          if (!Number.isFinite(channel[i])) {
            scope.postMessage({ error: 'PCM contains NaN or Infinity.', code: 'INVALID_ARGUMENT' });
            return null;
          }
          const value = Math.max(-1, Math.min(1, channel[i]));
          pcm[i] = Math.round(value * (value < 0 ? 32768 : 32767));
        }
        return pcm;
      });
      if (channels.some(channel => channel === null)) return;
      const left = channels[0]!;
      for (let offset = 0; offset < left.length; offset += 1152) {
        append(encoder.encodeBuffer(left.subarray(offset, offset + 1152), channels[1]?.subarray(offset, offset + 1152)));
      }
    } else if (data.type === 'finish') {
      if (!encoder) throw new Error('Encoder is not initialized.');
      append(encoder.flush());
      encoder = undefined;
    } else {
      throw new Error('Unknown encoder message.');
    }
    scope.postMessage({ chunks }, chunks.map(chunk => chunk.buffer));
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error), code: 'ENCODE_FAILED' });
  }
};
