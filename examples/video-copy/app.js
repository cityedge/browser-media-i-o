const $ = id => document.getElementById(id);
let session, source, plan, audioInfo, controller, url;
const text = (ja, en) => $('lang').value === 'ja' ? ja : en;
function language() { document.documentElement.lang = $('lang').value; document.querySelectorAll('[data-ja]').forEach(el => { el.textContent = el.dataset[$('lang').value]; }); }
$('lang').onchange = language; language();
function invalidate() { plan = undefined; $('blob').disabled = $('stream').disabled = true; $('download').hidden = $('preview').hidden = true; if (url) URL.revokeObjectURL(url); }
for (const id of ['ranges', 'audio', 'bitrate', 'validation']) $(id).oninput = invalidate;
$('validation').onchange = () => { invalidate(); $('force-warning').hidden = $('validation').value !== 'container'; };
$('file').onchange = async () => { invalidate(); await session?.close(); source?.close(); session = source = undefined; $('inspect').disabled = !$('file').files.length; };
$('cancel').onclick = () => controller?.abort();
function busy(value) { for (const id of ['file', 'ranges', 'audio', 'bitrate', 'validation', 'inspect']) $(id).disabled = value; $('cancel').disabled = !value; $('blob').disabled = $('stream').disabled = value || !plan; }
const progress = p => { $('status').textContent = `${p.stage}: ${p.fraction === null ? '…' : (p.fraction * 100).toFixed(1) + '%'}\n${p.videoPackets} video / ${p.audioSamples} PCM`; };
$('inspect').onclick = async () => {
  invalidate(); controller = new AbortController(); busy(true);
  try {
    await session?.close(); source?.close();
    const file = $('file').files[0]; session = await BrowserMediaIO.openVideoCopy(file, { validation: $('validation').value }); source = await BrowserMediaIO.openMedia(file);
    const media = await source.probe(), info = await session.inspect({ signal: controller.signal, onProgress: progress });
    audioInfo = media.tracks.find(t => t.audio)?.audio;
    if ($('audio').value === 'pcm' && !audioInfo) throw Error(text('音声トラックがありません。音声なしを選んでください。', 'No audio track. Select no audio.'));
    plan = await session.plan({ keepRanges: JSON.parse($('ranges').value), snap: 'inside', audioSampleRate: $('audio').value === 'pcm' ? audioInfo.sampleRate : undefined, signal: controller.signal });
    $('status').textContent = text('調整後の区間を確認してから保存してください。\n', 'Review the adjusted ranges before saving.\n') + JSON.stringify({ info, plan }, null, 2);
  } catch (e) { $('status').textContent = `${e.code || ''} ${e.reason || ''}: ${e.message}`; }
  finally { busy(false); }
};
async function save(direct) {
  let destination;
  try {
    // Invoke the picker during the user's gesture, before awaiting AAC initialization.
    const handle = direct ? await showSaveFilePicker({ suggestedName: 'video-copy.mp4', types: [{ description: 'MP4', accept: { 'video/mp4': ['.mp4'] } }] }) : undefined;
    controller = new AbortController(); busy(true);
    let audio;
    if ($('audio').value === 'pcm') {
      const bitrate = Number($('bitrate').value) * 1000;
      await BrowserMediaIO.enableAacFallback({ sampleRate: audioInfo.sampleRate, channels: audioInfo.channels, audioBitrate: bitrate });
      audio = { mode: 'pcm', sampleRate: audioInfo.sampleRate, channels: audioInfo.channels, bitrate,
        blocks: signal => VideoCopyExample.pcm(source, plan, audioInfo.channels, signal) };
    }
    destination = handle ? await handle.createWritable() : undefined;
    const result = await session.exportMp4({ plan, audio, target: destination ? { kind: 'stream', stream: destination } : undefined, signal: controller.signal, onProgress: progress });
    if (result.blob) { if (url) URL.revokeObjectURL(url); url = URL.createObjectURL(result.blob); $('download').href = url; $('download').download = 'video-copy.mp4'; $('download').hidden = false; $('preview').src = url; $('preview').hidden = false; }
    $('status').textContent = JSON.stringify({ ...result, blob: undefined }, null, 2);
  } catch (e) { if (destination && !destination.locked) await destination.abort().catch(() => {}); $('status').textContent = `${e.code || ''} ${e.reason || ''}: ${e.message}`; }
  finally { busy(false); }
}
$('blob').onclick = () => save(false);
$('stream').onclick = () => { if (!globalThis.showSaveFilePicker) $('status').textContent = text('この環境は直接保存に対応していません。', 'Direct file saving is unavailable in this environment.'); else void save(true); };
