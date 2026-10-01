import type { MediaInput, MediaInfo } from 'browser-media-io';

export interface Cue {
  start: number;
  end: number;
  text: string;
}
export function parseSrt(text: string): Cue[] {
  const clean = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!clean) return [];
  const clock = (h: string, m: string, s: string, ms: string) => {
    if (Number(m) >= 60 || Number(s) >= 60) throw new Error('SRTの分・秒は0〜59で指定してください。');
    return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  };
  return clean
    .split(/\n\s*\n/)
    .map((block, index) => {
      const lines = block.split('\n');
      if (/^\d+$/.test(lines[0].trim())) lines.shift();
      const match = lines
        .shift()
        ?.match(/^(\d{2,}):(\d{2}):(\d{2}),(\d{3})\s+-->\s+(\d{2,}):(\d{2}):(\d{2}),(\d{3})\s*$/);
      if (!match || !lines.join('\n').trim())
        throw new Error(`字幕${index + 1}の時刻または本文を確認してください。SRT形式で入力します。`);
      const start = clock(match[1], match[2], match[3], match[4]);
      const end = clock(match[5], match[6], match[7], match[8]);
      if (end <= start) throw new Error(`字幕${index + 1}の終了時刻は開始時刻より後にしてください。`);
      return { start, end, text: lines.join('\n') };
    })
    .sort((a, b) => a.start - b.start);
}

export type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export interface Composition {
  image?: ImageBitmap;
  video?: MediaInput;
  videoEnd?: number;
  cues: Cue[];
}
function contain(width: number, height: number, outWidth: number, outHeight: number) {
  const scale = Math.min(outWidth / width, outHeight / height);
  return [
    (outWidth - width * scale) / 2,
    (outHeight - height * scale) / 2,
    width * scale,
    height * scale,
  ] as const;
}

// Drawing and subtitle layout belong to this app, independent of media I/O.
export async function drawComposition(ctx: Context, time: number, composition: Composition) {
  const { width, height } = ctx.canvas;
  ctx.reset();
  ctx.fillStyle = '#111219';
  ctx.fillRect(0, 0, width, height);
  if (composition.image) {
    const image = composition.image;
    ctx.drawImage(image, ...contain(image.width, image.height, width, height));
  } else if (composition.video) {
    const at = Math.min(time, Math.max(0, (composition.videoEnd ?? 0) - 0.00001));
    const frame = await composition.video.getVideoFrame(at);
    try {
      if (frame) frame.draw(ctx, ...contain(frame.width, frame.height, width, height));
    } finally {
      frame?.close();
    }
  } else {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#242140');
    gradient.addColorStop(1, '#656d83');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.translate(width * 0.72, height * 0.37);
    ctx.rotate(time * 0.09 - 0.3);
    for (let i = 10; i >= 0; i--) {
      const radius = height * (0.14 + i * 0.026);
      ctx.strokeStyle = `rgba(209,198,241,${0.15 + (10 - i) * 0.025})`;
      ctx.lineWidth = height * 0.013;
      ctx.beginPath();
      ctx.ellipse(0, 0, radius, radius * 0.65, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = '#c3b8de';
    ctx.font = `500 ${height * 0.024}px sans-serif`;
    ctx.fillText('A MOMENT, IN MOTION', width * 0.075, height * 0.29);
    ctx.fillStyle = '#fbf7ff';
    ctx.font = `500 ${height * 0.108}px sans-serif`;
    ctx.fillText('Make it', width * 0.07, height * 0.45);
    ctx.fillText('a moving story.', width * 0.07, height * 0.58);
    ctx.fillStyle = '#c7c2d4';
    ctx.font = `${height * 0.025}px sans-serif`;
    ctx.fillText('FRAMECRAFT   /   YOUR BROWSER, YOUR STUDIO', width * 0.075, height * 0.7);
  }
  const active = composition.cues.filter((cue) => cue.start <= time && time < cue.end);
  if (!active.length) return;
  const fontSize = Math.max(12, Math.round(height * 0.046));
  ctx.font = `600 ${fontSize}px sans-serif`;
  const lines: string[] = [];
  for (const cue of active)
    for (const paragraph of cue.text.split('\n')) {
      let line = '';
      for (const letter of paragraph) {
        if (line && ctx.measureText(line + letter).width > width * 0.86) {
          lines.push(line);
          line = '';
        }
        line += letter;
      }
      lines.push(line);
    }
  const lineHeight = fontSize * 1.4;
  const y = height * 0.91 - (lines.length - 1) * lineHeight;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = fontSize * 0.16;
  for (let i = 0; i < lines.length; i++) {
    ctx.strokeStyle = '#000c';
    ctx.strokeText(lines[i], width / 2, y + i * lineHeight);
    ctx.fillStyle = '#fff';
    ctx.fillText(lines[i], width / 2, y + i * lineHeight);
  }
}

/** Keep the MP4 presentation timeline, including leading silence and edit-list trimming. */
export async function videoAudio(input: MediaInput, info: MediaInfo): Promise<AudioBuffer | undefined> {
  const track = info.tracks.find((t) => t.kind === 'audio');
  if (!track) return undefined;
  if (!track.canDecode || !track.audio) throw new Error('このブラウザでは動画の音声をデコードできません。');
  const { sampleRate, channels } = track.audio;
  const end = track.duration.seconds;
  if (!end || end > 600) throw new Error('動画の音声は10分以内で、長さを取得できるものを使用してください。');
  const length = Math.ceil(end * sampleRate);
  if (length * channels * 4 > 256 * 1024 * 1024) throw new Error('動画の音声PCMが256 MiBを超えています。');
  const audio = new AudioBuffer({ length, sampleRate, numberOfChannels: channels });
  for await (const block of input.audioBlocks({ end, trackId: track.id })) {
    const offset = Math.round(block.timestamp * sampleRate);
    for (let c = 0; c < channels; c++) {
      const from = Math.max(0, -offset),
        at = Math.max(0, offset);
      const to = Math.min(block.buffer.length, length - offset);
      if (to > from) audio.copyToChannel(block.buffer.getChannelData(c).subarray(from, to), c, at);
    }
  }
  return audio;
}

export const demoSrt =
  '1\n00:00:00,500 --> 00:00:02,500\n素材を、ひとつの動画に。\n\n2\n00:00:03,000 --> 00:00:05,500\n音と字幕も、ブラウザの中で。';
export function demoAudio() {
  const audio = new AudioBuffer({ length: 6 * 48000, sampleRate: 48000, numberOfChannels: 2 });
  for (let c = 0; c < 2; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const t = i / 48000,
        noteTime = t % 0.75;
      const frequency = [261.63, 329.63, 392, 523.25, 440, 392, 329.63, 261.63][Math.floor(t / 0.75)];
      data[i] =
        0.18 *
        Math.sin(2 * Math.PI * frequency * t + c * 0.1) *
        Math.exp(-noteTime * 5) *
        Math.min(1, noteTime * 100) *
        Math.min(1, (6 - t) * 20);
    }
  }
  return audio;
}
