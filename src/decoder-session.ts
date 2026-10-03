import { AudioSampleSink, VideoSampleSink, EncodedPacketSink, type AudioSample, type VideoSample,
  type EncodedPacket, type PacketRetrievalOptions } from 'mediabunny';
import { fail } from './errors.js';

/**
 * Mediabunny 1.61.0's iterator.return() wakes its producer but does not join it.
 * Isolate the two version-specific instance hooks here (no globals or dependency edits).
 * Observe the real decoder.close(), and use demand-driven packet traversal so no
 * detached packet-prefetch task survives that close. Keep the dependency exactly pinned.
 */
export function decoderSession<T extends AudioSample | VideoSample>(sink: AudioSampleSink | VideoSampleSink,
  create: () => AsyncIterator<T>): { iterator: AsyncIterator<T>; close(): Promise<void> } {
  type Decoder = { close(): void };
  type Hooks = {
    _createDecoder(...args: unknown[]): Promise<Decoder>;
    _createPacketSink(): EncodedPacketSink;
  };
  const hooks = sink as unknown as Hooks;
  if (typeof hooks._createDecoder !== 'function' || typeof hooks._createPacketSink !== 'function') {
    fail('UNSUPPORTED', 'Decoder lifetime adapter requires Mediabunny 1.61.0.');
  }
  const originalDecoder = hooks._createDecoder.bind(sink);
  let closed = Promise.resolve();
  hooks._createDecoder = async (...args) => {
    let done!: () => void;
    closed = new Promise<void>(resolve => { done = resolve; });
    try {
      const decoder = await originalDecoder(...args);
      const close = decoder.close.bind(decoder);
      decoder.close = () => { try { close(); } finally { done(); } };
      return decoder;
    } catch (error) { done(); throw error; }
  };
  const originalPackets = hooks._createPacketSink.bind(sink);
  hooks._createPacketSink = () => {
    const packets = originalPackets();
    packets.packets = async function* (start?: EncodedPacket, end?: EncodedPacket, options: PacketRetrievalOptions = {}) {
      let packet = start ?? await packets.getFirstPacket(options);
      while (packet && (!end || packet.sequenceNumber < end.sequenceNumber)) {
        yield packet;
        packet = await packets.getNextPacket(packet, options);
      }
    };
    return packets;
  };
  const iterator = create();
  let cleanup: Promise<void> | undefined;
  return { iterator, close() {
    return cleanup ??= (async () => {
      try { await iterator.return?.(); }
      finally { await closed; }
    })();
  } };
}
