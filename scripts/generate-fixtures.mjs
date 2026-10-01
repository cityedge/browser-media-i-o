import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export const fixtureDir = fileURLToPath(new URL('../tests/fixtures/generated/', import.meta.url));
export const truth = {
  width: 320, height: 180, fps: 30, frames: 300, duration: 10,
  sampleRate: 48000, channels: 2, sampleCount: 480000,
  // Independent timing markers on each channel catch swaps and synchronization errors.
  pulses: [[1, 4, 8], [2, 5, 9]], pulseDuration: 0.1,
  marker: { bits: 10, cellWidth: 24, x: 16, y: 16, height: 32 },
};

export function ffmpeg(args, options = {}) {
  return execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
    timeout: 60_000, maxBuffer: 128 * 1024 * 1024, ...options,
  });
}

export async function generateFixtures() {
  await mkdir(fixtureDir, { recursive: true });
  const pcm = Buffer.alloc(truth.sampleCount * truth.channels * 4);
  for (let i = 0; i < truth.sampleCount; i++) {
    const t = i / truth.sampleRate;
    for (let channel = 0; channel < truth.channels; channel++) {
      let value = 0;
      for (const start of truth.pulses[channel]) {
        const local = t - start;
        if (local >= 0 && local < truth.pulseDuration) {
          const envelope = Math.min(1, local / 0.005, (truth.pulseDuration - local) / 0.005);
          value += 0.7 * envelope * Math.sin(2 * Math.PI * (channel ? 600 : 1000) * local);
        }
      }
      pcm.writeFloatLE(value, (i * truth.channels + channel) * 4);
    }
  }
  const pcmPath = path.join(fixtureDir, 'reference.f32');
  await writeFile(pcmPath, pcm);
  ffmpeg(['-f', 'f32le', '-ar', String(truth.sampleRate), '-ac', '2', '-i', pcmPath, '-c:a', 'pcm_s16le', path.join(fixtureDir, 'reference.wav')]);

  const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '320x180', '-framerate', '30', '-i', 'pipe:0',
    '-i', path.join(fixtureDir, 'reference.wav'),
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p',
    '-preset', 'fast', '-crf', '18', '-g', '30', '-bf', '2',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', path.join(fixtureDir, 'reference.mp4'),
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  child.stdin.on('error', () => {}); // exit status and stderr below carry encoder failures
  const completion = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Fixture encoding failed (${code}): ${stderr}`)));
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
  // Attach a handler immediately, even if a pipe error arrives while frames are being written.
  completion.catch(() => {});
  try {
    for (let n = 0; n < truth.frames; n++) {
      const rgb = Buffer.alloc(truth.width * truth.height * 3);
      const m = truth.marker;
      for (let y = 0; y < truth.height; y++) {
        for (let x = 0; x < truth.width; x++) {
          let value = 32 + Math.floor(80 * n / truth.frames);
          if (y >= m.y && y < m.y + m.height && x >= m.x && x < m.x + m.bits * m.cellWidth) {
            value = (n >> Math.floor((x - m.x) / m.cellWidth)) & 1 ? 235 : 16;
          }
          const offset = (y * truth.width + x) * 3;
          rgb.fill(value, offset, offset + 3);
        }
      }
      if (!child.stdin.write(rgb)) await once(child.stdin, 'drain');
    }
    child.stdin.end();
    await completion;
  } finally { clearTimeout(timeout); }

  ffmpeg(['-i', path.join(fixtureDir, 'reference.wav'), '-c:a', 'libmp3lame', '-q:a', '3', path.join(fixtureDir, 'reference.mp3')]);
  const mp3 = await readFile(path.join(fixtureDir, 'reference.mp3'));
  const xing = mp3.indexOf('Xing');
  if (xing < 0 || !(mp3.readUInt32BE(xing + 4) & 1)) throw new Error('Expected Xing frame count in generated MP3');
  // Deliberately lie about frame count. Actual compressed audio payload remains intact.
  const originalFrameCount = mp3.readUInt32BE(xing + 8);
  mp3.writeUInt32BE(Math.floor(originalFrameCount / 2), xing + 8);
  await writeFile(path.join(fixtureDir, 'wrong-duration.mp3'), mp3);
  await writeFile(path.join(fixtureDir, 'manifest.json'), JSON.stringify({
    ...truth, generatedAt: new Date().toISOString(),
    malformed: { file: 'wrong-duration.mp3', originalFrameCount, declaredFrameCount: Math.floor(originalFrameCount / 2) },
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await generateFixtures();
  console.log(`Generated media fixtures in ${fixtureDir}`);
}
