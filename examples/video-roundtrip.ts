import { openMedia, decodeAudio, renderMp4 } from 'browser-media-io';
import { enableAacFallback } from 'browser-media-io/aac';

/** Minimal zero-origin, single-soundtrack example; composition remains the app's responsibility. */
export async function roundTrip(file: File, signal?: AbortSignal) {
  const input = await openMedia(file, { signal });
  try {
    const info = await input.probe();
    const video = info.tracks.find(track => track.kind === 'video');
    if (!video?.video || !video.duration.seconds) throw new Error('A timed video track is required.');
    const audio = info.tracks.some(track => track.kind === 'audio') ? await decodeAudio(file, { signal }) : undefined;
    if (audio) await enableAacFallback({ sampleRate: audio.sampleRate, channels: audio.channels });
    return await renderMp4({
      width: video.video.width, height: video.video.height, fps: 30, duration: video.duration.seconds,
      audio: audio?.buffer, signal,
      renderFrame: async (context, time) => {
        const frame = await input.getVideoFrame(time, { trackId: video.id });
        if (!frame) return; // The app chooses the appearance of timeline gaps.
        try { frame.draw(context); } finally { frame.close(); }
      },
    });
  } finally { input.close(); }
}
