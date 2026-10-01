import {
  decodeAudio,
  getCapabilities,
  MediaError,
  openMedia,
  probe,
  renderMp4,
  type MediaInfo,
  type MediaInput,
  type Mp4Result,
} from 'browser-media-io';
import { enableAacFallback } from 'browser-media-io/aac';
import { demoAudio, demoSrt, drawComposition, parseSrt, videoAudio, type Cue } from './composition.js';
import './style.css';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const visual = el<HTMLInputElement>('visual'),
  sound = el<HTMLInputElement>('sound');
const subtitles = el<HTMLTextAreaElement>('subtitles'),
  srtFile = el<HTMLInputElement>('srt-file');
const size = el<HTMLSelectElement>('size'),
  fps = el<HTMLSelectElement>('fps'),
  duration = el<HTMLInputElement>('duration');
const canvas = el<HTMLCanvasElement>('preview'),
  seek = el<HTMLInputElement>('seek');
const context = canvas.getContext('2d')!;
const renderButton = el<HTMLButtonElement>('render'),
  cancelButton = el<HTMLButtonElement>('cancel');
const progress = el<HTMLProgressElement>('progress'),
  playButton = el<HTMLButtonElement>('play');
const errorBox = el<HTMLParagraphElement>('error'),
  status = el<HTMLParagraphElement>('status');

let image: ImageBitmap | undefined, video: MediaInput | undefined, videoFile: File | undefined;
let videoInfo: MediaInfo | undefined, soundInfo: MediaInfo | undefined;
let embeddedAudio: AudioBuffer | undefined, soundtrack: AudioBuffer | undefined;
let cues: Cue[] = [],
  subtitleError = '',
  busy: 'loading' | 'exporting' | null = null;
let controller: AbortController | undefined, outputUrl: string | undefined;
let resultInfo: Omit<Mp4Result, 'blob'> | undefined, outputInfo: MediaInfo | undefined;
let encoder: 'native' | 'wasm' | 'none' | undefined;
let capabilities: Awaited<ReturnType<typeof getCapabilities>> | undefined;
let lastFailure: { code: string; message: string } | undefined;
let previewRequest = 0,
  previewWork: Promise<void> | undefined;
let audioContext: AudioContext | undefined, audioNode: AudioBufferSourceNode | undefined;
let playing = false,
  playbackGeneration = 0,
  playbackStart = 0,
  playbackOffset = 0,
  animation = 0;

const audio = () => soundtrack ?? embeddedAudio;
const videoEnd = () => videoInfo?.tracks.find((track) => track.video)?.duration.seconds ?? 0;
const seconds = (value: number) => `${value.toFixed(3)} 秒`;
const clock = (value: number) => `${Math.floor(value / 60)}:${(value % 60).toFixed(3).padStart(6, '0')}`;
function reportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  lastFailure = { code: error instanceof MediaError ? error.code : 'APP_ERROR', message };
  errorBox.textContent = `処理できませんでした: ${message}`;
  errorBox.hidden = false;
  refreshDiagnostics();
}
function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = '';
}
function invalidateOutput() {
  if (outputUrl) {
    URL.revokeObjectURL(outputUrl);
    outputUrl = undefined;
  }
  const player = el<HTMLVideoElement>('result-video');
  player.removeAttribute('src');
  player.load();
  el<HTMLAnchorElement>('download').removeAttribute('href');
  el('result').hidden = true;
  resultInfo = undefined;
  outputInfo = undefined;
  encoder = undefined;
  progress.hidden = true;
  progress.value = 0;
}
function configuration() {
  const [width, height] = size.value.split('x').map(Number);
  const length = Number(duration.value),
    rate = Number(fps.value);
  if (!Number.isFinite(length) || length < 0.1 || length > 600)
    throw new Error('長さを0.1秒〜600秒で指定してください。');
  return { width, height, fps: rate, duration: length };
}
function refreshSettings() {
  let valid = true;
  try {
    const config = configuration();
    seek.max = String(config.duration);
    seek.value = String(Math.min(Number(seek.value), config.duration));
    el('end-time').textContent = clock(config.duration);
    el('estimate').textContent =
      `${Math.ceil(config.duration * config.fps - 1e-9).toLocaleString()} frames · ${seconds(config.duration)}`;
    el('preview-size').textContent = `${config.width} × ${config.height}`;
  } catch {
    valid = false;
    el('estimate').textContent = '長さは0.1秒〜600秒';
  }
  renderButton.disabled = !!busy || !valid || !!subtitleError || capabilities?.h264Encode === false;
  playButton.disabled = !!busy || !valid || !!subtitleError;
  seek.disabled = !!busy || !valid || !!subtitleError;
}
function setBusy(value: typeof busy) {
  busy = value;
  el<HTMLFieldSetElement>('materials-controls').disabled = !!value;
  el<HTMLFieldSetElement>('export-controls').disabled = !!value;
  el<HTMLButtonElement>('demo').disabled = !!value;
  renderButton.hidden = value === 'exporting';
  cancelButton.hidden = value !== 'exporting';
  cancelButton.disabled = false;
  refreshSettings();
}
function refreshDiagnostics() {
  const pcm = audio();
  const report = {
    app: 'Framecraft 0.1.0',
    library: 'browser-media-io 0.1.0',
    browser: navigator.userAgent,
    capabilities,
    configuration: { size: size.value, fps: Number(fps.value), duration: Number(duration.value) },
    video: videoInfo ?? null,
    soundtrack: soundInfo ?? null,
    decodedAudio: pcm
      ? {
          source: soundtrack ? 'soundtrack' : 'video-timeline',
          sampleCount: pcm.length,
          sampleRate: pcm.sampleRate,
          channels: pcm.numberOfChannels,
          duration: pcm.length / pcm.sampleRate,
        }
      : null,
    subtitles: { count: cues.length, valid: !subtitleError },
    aacEncoder: encoder,
    output: resultInfo ?? null,
    outputProbe: outputInfo ?? null,
    lastFailure: lastFailure ?? null,
  };
  el('diagnostics').textContent = JSON.stringify(report, null, 2);
  return report;
}
function updateDuration() {
  duration.value = String(Math.min(600, Math.max(0.1, audio()?.duration ?? (videoEnd() || 10))));
  seek.value = '0';
  refreshSettings();
  refreshDiagnostics();
}
function describeAudio(buffer: AudioBuffer) {
  return `実測 ${seconds(buffer.duration)} · ${buffer.length.toLocaleString()} samples\n${buffer.sampleRate.toLocaleString()} Hz · ${buffer.numberOfChannels} ch`;
}
function updateLabels() {
  el('clear-visual').hidden = !image && !video;
  el('clear-sound').hidden = !soundtrack;
  if (!image && !video) el('visual-info').textContent = '未選択 · グラフィック背景を使用';
  if (!soundtrack)
    el('sound-info').textContent = embeddedAudio
      ? `動画の音声を使用\n${describeAudio(embeddedAudio)}`
      : '未選択 · 動画に音声があれば使用';
}
function pause() {
  playing = false;
  playbackGeneration++;
  cancelAnimationFrame(animation);
  audioNode?.stop();
  audioNode?.disconnect();
  audioNode = undefined;
  playButton.textContent = '▶';
  playButton.setAttribute('aria-label', 'プレビュー再生');
}
// A single decode loop coalesces rapid scrubbing; MediaInput permits one operation at a time.
function requestPreview() {
  previewRequest++;
  if (previewWork) return previewWork;
  previewWork = (async () => {
    let completed = -1;
    while (completed !== previewRequest) {
      completed = previewRequest;
      const [width, height] = size.value.split('x').map(Number);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const time = Number(seek.value);
      await drawComposition(context, time, { image, video, videoEnd: videoEnd(), cues });
      el('time').textContent = clock(time);
    }
  })()
    .catch((error) => {
      pause();
      reportError(error);
    })
    .finally(() => {
      previewWork = undefined;
    });
  return previewWork;
}
async function load(action: () => Promise<void> | void, resetDuration = true) {
  if (busy) return;
  pause();
  setBusy('loading');
  clearError();
  status.textContent = '素材を読み込んでいます…';
  try {
    await previewWork;
    await action();
    invalidateOutput();
    updateLabels();
    if (resetDuration) updateDuration();
    else {
      refreshSettings();
      refreshDiagnostics();
    }
    status.textContent = '読み込み完了。プレビューで確認できます。';
  } catch (error) {
    status.textContent = '読み込みに失敗しました。直前の素材を保持しています。';
    reportError(error);
  } finally {
    setBusy(null);
    void requestPreview();
  }
}
function releaseVisual() {
  image?.close();
  image = undefined;
  video?.close();
  video = undefined;
  videoFile = undefined;
  videoInfo = undefined;
  embeddedAudio = undefined;
}

visual.addEventListener('change', () => {
  const file = visual.files?.[0];
  if (!file) return;
  void load(async () => {
    if (file.type.startsWith('image/')) {
      const next = await createImageBitmap(file);
      releaseVisual();
      image = next;
      el('visual-info').textContent = `${file.name}\n${next.width} × ${next.height}`;
    } else {
      const next = await openMedia(file);
      try {
        const info = await next.probe();
        const track = info.tracks.find((t) => t.video);
        if (!track?.canDecode || !track.duration.seconds)
          throw new Error('このブラウザでデコード可能な映像トラックを含むMP4を選んでください。');
        if (track.duration.seconds > 600) throw new Error('評価用アプリの動画入力は10分以内です。');
        const pcm = await videoAudio(next, info);
        releaseVisual();
        video = next;
        videoFile = file;
        videoInfo = info;
        embeddedAudio = pcm;
        el('visual-info').textContent =
          `${file.name}\n${track.video!.width} × ${track.video!.height} · ${seconds(track.duration.seconds)}\n${track.packetCount} packets · ${track.video!.cadence}`;
      } catch (error) {
        next.close();
        throw error;
      }
    }
  }).finally(() => {
    visual.value = '';
  });
});
sound.addEventListener('change', () => {
  const file = sound.files?.[0];
  if (!file) return;
  void load(async () => {
    const info = await probe(file);
    const decoded = await decodeAudio(file, { maxDecodedBytes: 256 * 1024 * 1024 });
    if (decoded.duration > 600) throw new Error('評価用アプリの音源入力は10分以内です。');
    soundtrack = decoded.buffer;
    soundInfo = info;
    const header = info.tracks.find((t) => t.audio)?.metadataDuration;
    const difference =
      header != null && Math.abs(header - decoded.duration) > 0.05
        ? `\nヘッダーは${seconds(header)}。実測値を使用します。`
        : '';
    el('sound-info').textContent = `${file.name}\n${describeAudio(decoded.buffer)}${difference}`;
  }).finally(() => {
    sound.value = '';
  });
});
el('clear-visual').addEventListener('click', () => void load(releaseVisual));
el('clear-sound').addEventListener(
  'click',
  () =>
    void load(() => {
      soundtrack = undefined;
      soundInfo = undefined;
    }),
);

function updateSubtitles() {
  clearError();
  try {
    cues = parseSrt(subtitles.value);
    subtitleError = '';
    el('subtitle-info').textContent = cues.length
      ? `${cues.length}件の字幕 · テキストとして描画`
      : '字幕なし';
  } catch (error) {
    cues = [];
    subtitleError = (error as Error).message;
    el('subtitle-info').textContent = subtitleError;
    reportError(error);
  }
  invalidateOutput();
  refreshSettings();
  refreshDiagnostics();
  void requestPreview();
}
subtitles.addEventListener('input', () => {
  pause();
  updateSubtitles();
});
srtFile.addEventListener('change', () => {
  const file = srtFile.files?.[0];
  if (!file) return;
  void load(async () => {
    if (file.size > 1024 * 1024) throw new Error('字幕ファイルは1 MiB以内で指定してください。');
    const text = await file.text();
    parseSrt(text);
    subtitles.value = text;
    cues = parseSrt(text);
    subtitleError = '';
    el('subtitle-info').textContent = `${cues.length}件の字幕 · テキストとして描画`;
  }, false).finally(() => {
    srtFile.value = '';
  });
});
el('demo').addEventListener(
  'click',
  () =>
    void load(() => {
      releaseVisual();
      soundtrack = demoAudio();
      soundInfo = undefined;
      subtitles.value = demoSrt;
      cues = parseSrt(demoSrt);
      subtitleError = '';
      el('sound-info').textContent = `サンプル音源\n${describeAudio(soundtrack)}`;
      el('subtitle-info').textContent = `${cues.length}件の字幕 · テキストとして描画`;
    }),
);
for (const input of [size, fps, duration])
  input.addEventListener('input', () => {
    pause();
    invalidateOutput();
    refreshSettings();
    refreshDiagnostics();
    void requestPreview();
  });
seek.addEventListener('input', () => {
  pause();
  void requestPreview();
});
playButton.addEventListener('click', async () => {
  if (playing) {
    pause();
    return;
  }
  if (busy) return;
  const generation = ++playbackGeneration;
  try {
    if (Number(seek.value) >= Number(duration.value)) seek.value = '0';
    const pcm = audio();
    if (pcm) {
      audioContext ??= new AudioContext();
      await audioContext.resume();
      if (generation !== playbackGeneration || busy) return;
      if (Number(seek.value) < pcm.duration) {
        audioNode = audioContext.createBufferSource();
        audioNode.buffer = pcm;
        audioNode.connect(audioContext.destination);
        audioNode.start(0, Number(seek.value));
      }
    }
    playbackStart = performance.now();
    playbackOffset = Number(seek.value);
    playing = true;
    playButton.textContent = 'Ⅱ';
    playButton.setAttribute('aria-label', 'プレビュー停止');
    const tick = () => {
      if (!playing) return;
      seek.value = String(
        Math.min(Number(duration.value), playbackOffset + (performance.now() - playbackStart) / 1000),
      );
      void requestPreview();
      if (Number(seek.value) >= Number(duration.value)) {
        pause();
        return;
      }
      animation = requestAnimationFrame(tick);
    };
    tick();
  } catch (error) {
    pause();
    reportError(error);
  }
});

renderButton.addEventListener('click', async () => {
  if (busy) return;
  pause();
  clearError();
  invalidateOutput();
  setBusy('exporting');
  controller = new AbortController();
  progress.hidden = false;
  status.textContent = '書き出しを準備しています…';
  let exportVideo: MediaInput | undefined;
  try {
    const config = configuration(),
      pcm = audio();
    await previewWork;
    if (pcm)
      encoder = await enableAacFallback({ sampleRate: pcm.sampleRate, channels: pcm.numberOfChannels });
    else encoder = 'none';
    controller.signal.throwIfAborted();
    if (videoFile) exportVideo = await openMedia(videoFile, { signal: controller.signal });
    const result = await renderMp4({
      ...config,
      audio: pcm,
      signal: controller.signal,
      target: { kind: 'blob', maxBytes: 256 * 1024 * 1024 },
      renderFrame: (ctx, time) =>
        drawComposition(ctx, time, { image, video: exportVideo, videoEnd: videoEnd(), cues }),
      onProgress: (event) => {
        progress.value = event.fraction ?? 0;
        status.textContent =
          event.stage === 'encoding'
            ? `書き出し中… ${event.videoFrames.toLocaleString()} frames · ${Math.floor((event.fraction ?? 0) * 100)}%`
            : event.stage === 'finalizing'
              ? 'MP4を仕上げています…'
              : '出力したMP4の情報を確認しています…';
      },
    });
    outputInfo = await probe(result.blob!, { signal: controller.signal });
    const count = outputInfo.tracks.find((t) => t.video)?.packetCount;
    if (count !== result.videoFrames)
      throw new Error(`出力検査でフレーム数が一致しませんでした (${count} / ${result.videoFrames})。`);
    const { blob, ...metrics } = result;
    resultInfo = metrics;
    outputUrl = URL.createObjectURL(blob!);
    el<HTMLAnchorElement>('download').href = outputUrl;
    el<HTMLVideoElement>('result-video').src = outputUrl;
    el('result-info').textContent =
      `${result.videoFrames.toLocaleString()} frames · ${seconds(result.duration)} · ${(result.bytes / 1024 / 1024).toFixed(2)} MiB · ${pcm ? 'H.264 / AAC' : 'H.264 / 音声なし'}`;
    el('result').hidden = false;
    status.textContent = '書き出し完了。動画を再生して確認・ダウンロードできます。';
  } catch (error) {
    if (controller.signal.aborted) {
      status.textContent = '書き出しを中止しました。設定を変えて再実行できます。';
      progress.hidden = true;
    } else {
      status.textContent = '書き出しに失敗しました。評価レポートから詳細を確認できます。';
      reportError(error);
    }
  } finally {
    exportVideo?.close();
    controller = undefined;
    setBusy(null);
    refreshDiagnostics();
  }
});
cancelButton.addEventListener('click', () => {
  controller?.abort();
  cancelButton.disabled = true;
  status.textContent = '書き出しを中止しています…';
});
el('report').addEventListener('click', () => {
  const blob = new Blob(
    [JSON.stringify({ generatedAt: new Date().toISOString(), ...refreshDiagnostics() }, null, 2)],
    { type: 'application/json' },
  );
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = 'framecraft-report.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('pagehide', () => {
  pause();
  controller?.abort();
  video?.close();
  image?.close();
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  void audioContext?.close();
});

refreshSettings();
void requestPreview();
void getCapabilities()
  .then((value) => {
    capabilities = value;
    refreshSettings();
    refreshDiagnostics();
    if (!value.h264Encode)
      reportError(
        new Error('H.264出力に対応したデスクトップChromeまたはEdgeで、HTTPSかlocalhostから開いてください。'),
      );
  })
  .catch(reportError);
