// Legacy input entry: retain the decoder-shutdown guarantee and its version-specific adapter.
import { decoderSession } from './decoder-session.js';
import { MediaInput, type OpenOptions } from './input-core.js';
export * from './input-core.js';

export async function openMedia(blob: Blob, options: OpenOptions = {}): Promise<MediaInput> {
  return new MediaInput(blob, options, decoderSession).initialize();
}
