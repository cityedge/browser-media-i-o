import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ffmpeg } from './generate-fixtures.mjs';

export function verifyLongMedia(file, seconds) {
  const runProbe = args => JSON.parse(execFileSync(process.env.FFPROBE_PATH || 'ffprobe',
    ['-v', 'error', ...args, '-of', 'json', file], { encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 }));
  const info = runProbe(['-count_frames', '-show_streams', '-show_format']);
  const video = info.streams.find(s => s.codec_type === 'video'), audio = info.streams.find(s => s.codec_type === 'audio');
  assert.equal(video.codec_name, 'h264'); assert.equal(audio.codec_name, 'aac');
  assert.equal(Number(video.nb_read_frames), seconds * 30); assert.ok(Math.abs(Number(video.duration) - seconds) < 1e-5);
  assert.equal(Number(audio.sample_rate), 48000); assert.equal(audio.channels, 2);
  const frames = runProbe(['-select_streams', 'a:0', '-show_frames', '-show_entries', 'frame=nb_samples']);
  const decodedSamples = frames.frames.reduce((n, f) => n + Number(f.nb_samples), 0);
  assert.ok(Math.abs(decodedSamples - seconds * 48000) <= 1024, 'AAC end padding exceeds one packet');
  const indices = [0, seconds * 15, seconds * 30 - 1];
  const gray = ffmpeg(['-i', file, '-an', '-vf', `select='${indices.map(i => `eq(n,${i})`).join('+')}'`,
    '-fps_mode', 'passthrough', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'], { timeout: 180000 });
  assert.equal(gray.length, 320 * 180 * 3);
  const ids = indices.map((expected, i) => {
    let id = 0;
    for (let bit = 0; bit < 16; bit++) if (gray[i * 320 * 180 + 32 * 320 + 16 + bit * 18 + 9] > 128) id |= 1 << bit;
    assert.equal(id, expected, 'Long export frame marker'); return id;
  });
  const pulses = [[1, seconds / 2, seconds - 1], [2, seconds / 2 + 1, seconds - .5]], observed = [];
  for (let c = 0; c < 2; c++) {
    const starts = [];
    for (const time of pulses[c]) {
      const from = time - .2;
      const pcm = ffmpeg(['-ss', String(from), '-i', file, '-t', '0.5', '-vn', '-ar', '48000', '-ac', '2', '-f', 'f32le', 'pipe:1']);
      let found = null;
      for (let at = 0; at + 240 <= pcm.length / 8; at += 240) {
        let sum = 0; for (let n = 0; n < 240; n++) sum += pcm.readFloatLE((at + n) * 8 + c * 4) ** 2;
        if (Math.sqrt(sum / 240) > .1) { found = from + at / 48000; break; }
      }
      assert.notEqual(found, null, 'Missing long-export audio marker');
      assert.ok(Math.abs(found - time) <= .00500001, `Audio marker at ${time}: observed ${found}`);
      starts.push(found);
    }
    observed.push(starts);
  }
  return { videoFrames: Number(video.nb_read_frames), duration: Number(video.duration), decodedSamples, ids, pulses: observed,
    audioCodec: audio.codec_name, videoCodec: video.codec_name, bytes: Number(info.format.size) };
}
