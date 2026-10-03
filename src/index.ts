export { MediaError, type MediaErrorCode } from './errors.js';
export { frameTime, type FrameRate } from './time.js';
export { getCapabilities, type CapabilityOptions } from './capabilities.js';
export { openMedia, probe, decodeAudio, type MediaInput, type MediaFrame,
  type OpenOptions, type ProbeOptions, type MediaInfo, type TrackInfo, type DurationInfo, type DecodeAudioOptions } from './input.js';
export { createMp4Writer, renderMp4, type Mp4Writer,
  type WriterOptions, type RenderOptions, type AudioOutputOptions, type Mp4Target, type PositionedWrite, type ExportProgress, type Mp4Result } from './output.js';

export type { MediaReader } from './reader.js';
export type { PcmAudio, PcmBlock } from './pcm.js';
export type { ReadOptions, RangeReadOptions, AudioReadOptions, RequestedVideoFrame } from './input.js';
