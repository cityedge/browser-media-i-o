// Runtime implementation is built from third_party/lamejs by build-mp3.mjs.
export declare class Mp3Encoder {
  constructor(channels: number, sampleRate: number, kbps: number,
    options: { mode: 'cbr' | 'vbr' | 'abr'; vbrQuality?: number });
  encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
  flush(): Int8Array;
}
