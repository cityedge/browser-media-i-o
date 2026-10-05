/* Classic script: no fetch, imports, CDN, or server needed. */
(() => {
  'use strict';
  const api = window.BrowserMediaIO;
  const $ = id => document.getElementById(id);
  const words = {
    ja: {
      language: '言語', title: 'ファイルを開いて、変換して、保存。',
      intro: 'この端末のブラウザ内で処理します。インターネット接続・インストールは不要です。',
      inputTitle: '1. 素材を選ぶ', sourceLabel: '動画・音声ファイル（MP4 / WAV / MP3 / M4A）', outputTitle: '2. 書き出す',
      limits: 'サンプルの上限: 60秒・音声PCM 128 MiB・出力128 MiB。MP4は最大1280 × 720、30 fps。音声のみの場合は背景画像を生成します。',
      mp4: 'MP4を作成', mp3: 'MP3を作成', cancel: '中止', saveMp4: 'MP4を保存', saveMp3: 'MP3を保存',
      details: '入力情報・動作環境', browser: 'デスクトップChrome / Edge向け。保存時はファイル全体をメモリに保持します。',
      readme: '使い方・制限', licenses: 'ライセンス', idle: '素材を選択してください。', loading: '素材を確認しています…',
      ready: '準備できました。出力形式を選んでください。', working: '変換しています…', done: '完了しました。保存ボタンからダウンロードできます。',
      cancelled: '中止しました。再実行できます。', failed: '処理できませんでした。',
      tooLong: 'このサンプルの入力は60秒以内です。', noTrack: '読み取り可能な映像・音声がありません。',
      unavailable: 'H.264出力に対応したデスクトップChrome / Edgeで開いてください。', pcmLimit: '音声PCMが128 MiBを超えています。',
    },
    en: {
      language: 'Language', title: 'Open. Convert. Save.',
      intro: 'Processed in your browser on this device. No internet connection or installation required.',
      inputTitle: '1. Choose a file', sourceLabel: 'Video or audio (MP4 / WAV / MP3 / M4A)', outputTitle: '2. Export',
      limits: 'Sample limits: 60 seconds, 128 MiB decoded audio and 128 MiB output. MP4: up to 1280 × 720 at 30 fps. Audio-only files receive a generated background.',
      mp4: 'Create MP4', mp3: 'Create MP3', cancel: 'Cancel', saveMp4: 'Save MP4', saveMp3: 'Save MP3',
      details: 'File information and environment', browser: 'For desktop Chrome / Edge. Downloads hold the complete file in memory.',
      readme: 'Instructions and limits', licenses: 'Licenses', idle: 'Choose a file to begin.', loading: 'Inspecting the file…',
      ready: 'Ready. Choose an output format.', working: 'Converting…', done: 'Complete. Use the save button to download.',
      cancelled: 'Cancelled. You can try again.', failed: 'The operation failed.',
      tooLong: 'This sample accepts inputs up to 60 seconds.', noTrack: 'No decodable video or audio was found.',
      unavailable: 'Open in desktop Chrome / Edge with H.264 encoding support.', pcmLimit: 'Decoded audio exceeds 128 MiB.',
    },
  };
  let lang = 'ja', status = 'idle', busy = false, file, info, capabilities, controller;
  let error, backend, output;
  const urls = new Map(), limit = 128 * 1024 * 1024;
  const t = key => words[lang][key];
  const tracks = () => ({ video: info?.tracks.find(t => t.video), audio: info?.tracks.find(t => t.audio) });
  function refresh() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach(node => node.textContent = t(node.dataset.i18n));
    $('status').textContent = t(status);
    $('error').hidden = !error;
    $('error').textContent = error ? `${t('failed')} ${error.key ? t(error.key) : error.message}` : '';
    $('source').disabled = busy;
    $('cancel').hidden = !busy;
    $('cancel').disabled = !!controller?.signal.aborted;
    $('export-mp4').disabled = busy || !info || !capabilities?.h264Encode;
    $('export-mp3').disabled = busy || !tracks().audio?.canDecode;
    $('diagnostics').textContent = JSON.stringify({ protocol: location.protocol, secureContext: isSecureContext,
      browser: navigator.userAgent, capabilities, input: info, aacBackend: backend, output }, null, 2);
  }
  function clearOutputs() {
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
    for (const format of ['mp4', 'mp3']) { $('save-' + format).hidden = true; $('save-' + format).removeAttribute('href'); }
    output = undefined; backend = undefined;
  }
  function fail(key) { throw Object.assign(new Error(t(key)), { key }); }
  async function decodeSound(video, audio, signal) {
    if (!audio) return undefined;
    if (!audio.canDecode) fail('noTrack');
    if (!video) return (await api.decodeAudio(file, { signal, maxDecodedBytes: limit })).buffer;
    // MP4 PCM keeps its presentation timeline, including leading silence and edit lists.
    const { sampleRate, channels } = audio.audio;
    const end = audio.duration.seconds;
    if (!end || end > 60) fail('tooLong');
    const length = Math.ceil(end * sampleRate);
    if (length * channels * 4 > limit) fail('pcmLimit');
    const pcm = new AudioBuffer({ length, sampleRate, numberOfChannels: channels });
    const input = await api.openMedia(file, { signal });
    try {
      for await (const block of input.audioPcmBlocks({ end, trackId: audio.id, signal })) {
        const offset = Math.round(block.timestamp * sampleRate);
        const from = Math.max(0, -offset), to = Math.min(block.length, length - offset);
        if (to > from) for (let c = 0; c < channels; c++) pcm.copyToChannel(block.channelData[c].subarray(from, to), c, Math.max(0, offset));
      }
    } finally { input.close(); }
    return pcm;
  }
  async function run(action, phase) {
    if (busy) return;
    busy = true; error = undefined; controller = new AbortController(); status = phase;
    $('progress').hidden = phase !== 'working'; $('progress').value = 0;
    refresh();
    try { await action(controller.signal); }
    catch (cause) { status = controller.signal.aborted ? 'cancelled' : 'failed'; if (!controller.signal.aborted) error = cause; }
    finally { busy = false; controller = undefined; $('progress').hidden = true; refresh(); }
  }
  $('language').addEventListener('change', () => { lang = $('language').value; refresh(); });
  $('cancel').addEventListener('click', () => { controller?.abort(); refresh(); });
  $('source').addEventListener('change', () => {
    const selected = $('source').files[0];
    if (!selected) return;
    void run(async signal => {
      clearOutputs(); file = undefined; info = undefined; $('input-info').textContent = ''; $('preview').hidden = true;
      const input = await api.openMedia(selected, { signal });
      try {
        const next = await input.probe({ signal });
        const available = next.tracks.filter(t => (t.video || t.audio) && t.canDecode);
        if (!available.length) fail('noTrack');
        const length = Math.max(...available.map(t => t.duration.seconds ?? 0));
        if (length <= 0 || length > 60) fail('tooLong');
        if (next.tracks.some(t => (t.video || t.audio) && !t.canDecode)) fail('noTrack');
        if (next.tracks.some(t => t.video)) {
          const frame = await input.getVideoFrame(0, { signal });
          try { if (frame) { const canvas = $('preview'); canvas.width = frame.width; canvas.height = frame.height; frame.draw(canvas.getContext('2d'), 0, 0, canvas.width, canvas.height); canvas.hidden = false; } }
          finally { frame?.close(); }
        }
        signal.throwIfAborted();
        file = selected; info = next;
        $('input-info').textContent = `${selected.name} · ${length.toFixed(3)} s · ${(selected.size / 1048576).toFixed(2)} MiB`;
        status = 'ready';
      } finally { input.close(); }
    }, 'loading');
  });
  for (const format of ['mp4', 'mp3']) $('export-' + format).addEventListener('click', () => {
    if (!file) return;
    void run(async signal => {
      // Invalidate this format immediately so a failed retry cannot expose an older result.
      if (urls.has(format)) URL.revokeObjectURL(urls.get(format));
      urls.delete(format); $('save-' + format).hidden = true; $('save-' + format).removeAttribute('href');
      const { video, audio } = tracks();
      const pcm = await decodeSound(video, audio, signal);
      if (pcm && pcm.duration > 60) fail('tooLong');
      let blob, input;
      try {
        if (format === 'mp3') {
          blob = await api.encodeMp3(pcm, { signal, maxOutputBytes: limit, onProgress: fraction => $('progress').value = fraction });
          output = { format, bytes: blob.size, samples: pcm.length };
        } else {
          const scale = video ? Math.min(1, 1280 / video.video.width, 720 / video.video.height) : 1;
          const width = video ? Math.max(2, Math.floor(video.video.width * scale / 2) * 2) : 640;
          const height = video ? Math.max(2, Math.floor(video.video.height * scale / 2) * 2) : 360;
          const duration = Math.max(video?.duration.seconds ?? 0, pcm?.duration ?? 0);
          if (pcm) backend = await api.enableAacFallback({ width, height, sampleRate: pcm.sampleRate, channels: pcm.numberOfChannels });
          else backend = 'none';
          if (video) input = await api.openMedia(file, { signal });
          const result = await api.renderMp4({ width, height, fps: 30, duration, audio: pcm, signal,
            target: { kind: 'blob', maxBytes: limit },
            onProgress: event => $('progress').value = event.fraction ?? 0,
            renderFrame: async (ctx, time) => {
              ctx.fillStyle = '#152338'; ctx.fillRect(0, 0, width, height);
              if (input) {
                const frame = await input.getVideoFrame(Math.min(time, Math.max(0, video.duration.seconds - 0.000001)), { signal });
                try { if (frame) frame.draw(ctx, 0, 0, width, height); }
                finally { frame?.close(); }
              } else {
                ctx.fillStyle = '#bedaff'; ctx.font = '28px sans-serif'; ctx.fillText('Browser Media I/O', 32, height / 2);
              }
            },
          });
          blob = result.blob;
          const { blob: _blob, ...metrics } = result; output = { format, ...metrics };
        }
        signal.throwIfAborted();
        const url = URL.createObjectURL(blob); urls.set(format, url);
        const link = $('save-' + format); link.href = url;
        link.download = file.name.replace(/\.[^.]+$/, '') + '-converted.' + format; link.hidden = false;
        status = 'done';
      } finally { input?.close(); }
    }, 'working');
  });
  window.addEventListener('pagehide', () => { controller?.abort(); clearOutputs(); });
  refresh();
  api.getCapabilities().then(value => { capabilities = value; if (!value.h264Encode) error = { key: 'unavailable' }; refresh(); })
    .catch(cause => { error = cause; refresh(); });
})();
