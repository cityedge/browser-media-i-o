import { wavToMp3, encodeMp3 } from 'browser-media-io/mp3';

// Minimal addition to an application that already generates a finished WAV Blob.
export async function makeDownload(wav: Blob, format: 'wav' | 'mp3') {
  const blob = format === 'mp3' ? await wavToMp3(wav) : wav;
  return { blob, filename: `output.${format}` };
}

// If the app still has its AudioBuffer, avoid creating an intermediate WAV.
export async function mp3FromAudioBuffer(audio: AudioBuffer) {
  return encodeMp3(audio, { bitrate: 192000 });
}
