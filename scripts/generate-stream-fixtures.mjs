import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Walk only container boxes; never search arbitrary compressed payload bytes.
function boxes(data, start = 0, end = data.length) {
  const result = [];
  for (let at = start; at + 8 <= end;) {
    const size = data.readUInt32BE(at), type = data.toString('ascii', at + 4, at + 8);
    if (size < 8 || at + size > end) throw new Error(`Invalid fixture box ${type}`);
    result.push({ at, size, type });
    if (['moov', 'trak', 'moof', 'traf'].includes(type)) result.push(...boxes(data, at + 8, at + size));
    at += size;
  }
  return result;
}
export async function generateStreamFixtures(dir, ffmpeg) {
  const file = name => path.join(dir, name);
  // VFR oracle; reference.mp4 separately exercises reordered B frames, gaps.mp4 offsets.
  ffmpeg(['-i', file('reference.mp4'), '-an', '-vf', "select='not(mod(n,3))+eq(mod(n,10),1)'",
    '-fps_mode', 'vfr', '-c:v', 'libx264', '-threads', '2', '-bf', '0', '-g', '20', file('variable.mp4')]);

  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=10', '-frames:v', '4', '-an', '-c:v', 'libx264',
    '-threads', '2', '-bf', '0', '-g', '1', '-video_track_timescale', '1000000',
    '-movflags', 'empty_moov+default_base_moof+frag_every_frame', file('gaps.mp4')]);
  const gaps = await readFile(file('gaps.mp4'));
  const times = [1, 1.1, 2, 2.3];
  const decodeTimes = boxes(gaps).filter(b => b.type === 'tfdt');
  if (decodeTimes.length !== times.length) throw new Error('Expected one fragment per frame');
  decodeTimes.forEach((b, i) => {
    if (gaps[b.at + 8] === 1) gaps.writeBigUInt64BE(BigInt(times[i] * 1e6), b.at + 12);
    else gaps.writeUInt32BE(times[i] * 1e6, b.at + 12);
  });
  await writeFile(file('gaps.mp4'), gaps);

  // Corners have different grayscale values. Middle row is black -> white in five steps.
  const w = 160, h = 96, pixels = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const value = y < 24 ? (x < w / 2 ? 32 : 96) : y >= h - 24 ? (x < w / 2 ? 160 : 224)
      : [0, 64, 128, 192, 255][Math.min(4, Math.floor(x * 5 / w))];
    pixels.fill(value, (y * w + x) * 3, (y * w + x + 1) * 3);
  }
  await writeFile(file('gray.rgb'), pixels);
  ffmpeg(['-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${w}x${h}`, '-framerate', '1',
    '-i', file('gray.rgb'), '-vf', 'setsar=6/5', '-c:v', 'libx264', '-threads', '2', '-crf', '10',
    '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709',
    '-color_trc', 'bt709', file('gray-base.mp4')]);
  const base = await readFile(file('gray-base.mp4'));
  const tkhd = boxes(base).find(b => b.type === 'tkhd');
  if (!tkhd || base[tkhd.at + 8] !== 0) throw new Error('Expected version-zero video tkhd');
  for (const rotation of [0, 90, 180, 270]) for (const flip of [false, true]) {
    const data = Buffer.from(base), theta = rotation * Math.PI / 180;
    const a = Math.round(Math.cos(theta)), b = Math.round(Math.sin(theta)), f = flip ? -1 : 1;
    const matrix = [a * f, b, 0, -b * f, a, 0, 0, 0, 1];
    matrix.forEach((v, i) => data.writeInt32BE(v * (i % 3 === 2 ? 2 ** 30 : 65536), tkhd.at + 48 + i * 4));
    await writeFile(file(`gray-${rotation}-${Number(flip)}.mp4`), data);
  }
  const timing = {};
  for (const name of ['reference.mp4', 'variable.mp4', 'gaps.mp4']) {
    const info = JSON.parse(execFileSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time,duration_time,pict_type', '-of', 'json', file(name)], { encoding: 'utf8' }));
    timing[name] = info.frames.map(f => ({ timestamp: Number(f.best_effort_timestamp_time), duration: Number(f.duration_time), type: f.pict_type }));
  }
  await writeFile(file('timing.json'), JSON.stringify(timing, null, 2));
}
