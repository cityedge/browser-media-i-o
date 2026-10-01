import { canEncodeAudio, canEncodeVideo } from 'mediabunny';
import { frameRateValue, type FrameRate } from './time.js';
import { positive } from './errors.js';

export interface CapabilityOptions {
  width?: number; height?: number; fps?: FrameRate; videoBitrate?: number;
  sampleRate?: number; channels?: number; audioBitrate?: number;
}
export async function getCapabilities(options: CapabilityOptions = {}) {
  const { width = 1920, height = 1080, fps = 30, videoBitrate = 8_000_000,
    sampleRate = 48000, channels = 2, audioBitrate = 192_000 } = options;
  for (const [name, value] of Object.entries({ width, height, sampleRate, channels, videoBitrate, audioBitrate })) positive(value, name, true);
  const framerate = frameRateValue(fps);
  let nativeAacEncode = false;
  try {
    nativeAacEncode = typeof AudioEncoder !== 'undefined' && (await AudioEncoder.isConfigSupported({
      codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate: audioBitrate,
    })).supported === true;
  } catch { /* Browser does not expose this encoder. */ }
  return {
    secureContext: globalThis.isSecureContext === true,
    h264Encode: await canEncodeVideo('avc', { width, height, bitrate: videoBitrate, frameRate: framerate }),
    aacEncode: await canEncodeAudio('aac', { sampleRate, numberOfChannels: channels, bitrate: audioBitrate }),
    nativeAacEncode,
    opusEncode: await canEncodeAudio('opus', { sampleRate, numberOfChannels: channels, bitrate: audioBitrate }),
  };
}
