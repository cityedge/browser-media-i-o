// Independent bundle with no private decoder adapter in its import graph.
export * from './public.js';
export { enableAacFallback } from './aac.js';
export { encodeMp3, wavToMp3, type Mp3Audio, type Mp3Options, type WavToMp3Options } from './mp3.js';
