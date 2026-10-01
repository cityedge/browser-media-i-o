// The pinned 1.61.0 extension rebases FFmpeg AAC packets to the first input timestamp,
// including the AAC-LC encoder's 1024 priming samples. Restore the negative start
// timestamp so the MP4 muxer can describe that trim in its edit list.
let primingSamples = 0;
export function registerAacPriming() { primingSamples = 1024; }
export function aacPrimingSamples() { return primingSamples; }
