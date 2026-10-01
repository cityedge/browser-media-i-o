import { decodeAudio, getCapabilities, renderMp4, type ExportProgress } from 'browser-media-io';
import { enableAacFallback } from 'browser-media-io/aac';

/** Call from an app after obtaining a File from its own file picker. */
export async function makeVideo(audioFile: File, signal?: AbortSignal, onProgress?: (progress: ExportProgress) => void) {
  const audio = await decodeAudio(audioFile, { signal });
  if (!(await getCapabilities({ sampleRate: audio.sampleRate, channels: audio.channels })).aacEncode) {
    // Install the optional @mediabunny/aac-encoder dependency to use this path.
    await enableAacFallback({ sampleRate: audio.sampleRate, channels: audio.channels });
  }
  const result = await renderMp4({
    width: 1280, height: 720, fps: 30, duration: audio.duration,
    audio: audio.buffer, signal, onProgress,
    renderFrame(context, time) {
      context.fillStyle = '#142333'; context.fillRect(0, 0, 1280, 720);
      context.fillStyle = '#fff'; context.font = '48px sans-serif';
      context.fillText(`Audio video  ${time.toFixed(2)} s`, 70, 120);
      context.fillStyle = '#59d9aa'; context.fillRect(70, 600, 1140 * Math.min(1, time / audio.duration), 12);
    },
  });
  return result.blob!;
}
