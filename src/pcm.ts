import { fail, positive } from './errors.js';

/** Planar float PCM. The caller owns each channel array. No close() is needed. */
export interface PcmAudio {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  channelData: Float32Array[];
}
export interface PcmBlock extends PcmAudio { timestamp: number }

export function validatePcm(pcm: PcmAudio) {
  if (!pcm || typeof pcm !== 'object') fail('INVALID_ARGUMENT', 'Expected planar PCM.');
  positive(pcm.sampleRate, 'sampleRate', true); positive(pcm.numberOfChannels, 'numberOfChannels', true);
  positive(pcm.length, 'length', true);
  if (!Array.isArray(pcm.channelData) || pcm.channelData.length !== pcm.numberOfChannels
    || pcm.channelData.some(c => !(c instanceof Float32Array) || c.length !== pcm.length)) {
    fail('INVALID_ARGUMENT', 'Each PCM channel must be a Float32Array of length samples.');
  }
}
