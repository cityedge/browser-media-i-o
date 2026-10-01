import { getCapabilities, type CapabilityOptions } from './capabilities.js';
import { MediaError } from './errors.js';
import { registerAacPriming, aacPrimingSamples } from './aac-state.js';

let registration: Promise<void> | undefined;
/** Explicit opt-in. The extension is never downloaded or registered by the core entry point. */
export async function enableAacFallback(options: CapabilityOptions = {}): Promise<'native' | 'wasm'> {
  if (!aacPrimingSamples() && (await getCapabilities(options)).nativeAacEncode) return 'native';
  registration ??= import('@mediabunny/aac-encoder').then(({ registerAacEncoder }) => { registerAacEncoder(); registerAacPriming(); });
  try { await registration; }
  catch (cause) {
    registration = undefined;
    throw new MediaError('UNSUPPORTED', 'Install @mediabunny/aac-encoder to enable the optional AAC fallback.', { cause });
  }
  if (!(await getCapabilities(options)).aacEncode) throw new MediaError('UNSUPPORTED', 'AAC is unavailable for the requested configuration.');
  return 'wasm';
}
