import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ffmpeg, truth } from './generate-fixtures.mjs';

export function probe(file) {
  return JSON.parse(execFileSync(process.env.FFPROBE_PATH || 'ffprobe', [
    '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-show_frames',
    '-show_entries', 'frame=media_type,best_effort_timestamp_time', '-of', 'json', file,
  ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }));
}

// This oracle never uses the browser adapter to inspect its output.
export function verifyMedia(file, audioCodec, { pulseTolerance = 0.025 } = {}) {
  const info = probe(file);
  const video = info.streams.find(s => s.codec_type === 'video');
  const audio = info.streams.find(s => s.codec_type === 'audio');
  assert.ok(video, 'Video track is missing');
  assert.ok(audio, 'Audio track is missing');
  assert.equal(video.codec_name, 'h264');
  assert.equal(audio.codec_name, audioCodec);
  assert.equal(video.width, truth.width);
  assert.equal(video.height, truth.height);
  assert.equal(Number(video.nb_read_frames), truth.frames, 'Decoded video frame count');
  assert.equal(Number(audio.sample_rate), truth.sampleRate);
  assert.equal(audio.channels, truth.channels);

  const frames = info.frames.filter(f => f.media_type === 'video');
  assert.equal(frames.length, truth.frames);
  let maxVideoTimingError = 0;
  for (let i = 0; i < frames.length; i++) {
    const error = Math.abs(Number(frames[i].best_effort_timestamp_time) - i / truth.fps);
    assert.ok(error <= 0.000002, `Frame ${i}: timestamp error ${error}s`);
    maxVideoTimingError = Math.max(maxVideoTimingError, error);
  }
  assert.ok(Math.abs(Number(video.duration) - truth.duration) <= 1 / truth.fps, 'Video duration');
  const gray = ffmpeg(['-i', file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1']);
  const frameBytes = truth.width * truth.height;
  assert.equal(gray.length, frameBytes * truth.frames);
  const ids = [];
  for (let i = 0; i < truth.frames; i++) {
    let id = 0;
    const m = truth.marker;
    for (let bit = 0; bit < m.bits; bit++) {
      const value = gray[i * frameBytes + (m.y + 16) * truth.width + m.x + bit * m.cellWidth + 12];
      assert.ok(value < 64 || value > 192, `Unreadable frame marker at frame ${i}, bit ${bit}`);
      if (value > 128) id |= 1 << bit;
    }
    assert.equal(id, i, `Frame identity mismatch at output frame ${i}`);
    ids.push(id);
  }

  const pcm = ffmpeg(['-i', file, '-map', '0:a:0', '-ar', '48000', '-ac', '2', '-f', 'f32le', 'pipe:1']);
  const samples = pcm.length / (truth.channels * 4);
  assert.ok(Math.abs(samples - truth.sampleCount) <= truth.sampleRate * 0.05, `Audio length: ${samples} samples`);
  const starts = [];
  const bin = 240; // 5 ms windows; callers can require a tighter output synchronization bound.
  for (let c = 0; c < truth.channels; c++) {
    const channelStarts = [];
    let active = false;
    for (let offset = 0; offset < samples; offset += bin) {
      const end = Math.min(offset + bin, samples);
      let sum = 0;
      for (let s = offset; s < end; s++) sum += pcm.readFloatLE((s * truth.channels + c) * 4) ** 2;
      const next = Math.sqrt(sum / (end - offset)) > 0.1;
      if (next && !active) channelStarts.push(offset / truth.sampleRate);
      active = next;
    }
    assert.equal(channelStarts.length, truth.pulses[c].length, `Channel ${c}: pulse count`);
    for (let i = 0; i < channelStarts.length; i++) {
      assert.ok(Math.abs(channelStarts[i] - truth.pulses[c][i]) <= pulseTolerance + 1e-9, `Channel ${c}, pulse ${i}: A/V sync error`);
    }
    starts.push(channelStarts);
  }
  return { videoFrames: ids.length, firstFrameId: ids[0], lastFrameId: ids.at(-1), maxVideoTimingError,
    decodedAudioSamples: samples, pulseStarts: starts, audioCodec, ffprobe: info };
}
