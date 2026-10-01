// Test-only reference adapter. Replace this boundary with the original library when it exists.
// Mediabunny is used only to exercise the browser and container pipeline at this stage.
import {
  ALL_FORMATS, Input, BlobSource, VideoSampleSink, AudioSampleSink,
  Output, Mp4OutputFormat, BufferTarget, VideoSampleSource, AudioSampleSource,
  EncodedAudioPacketSource, EncodedPacketSink, canEncodeVideo, canEncodeAudio,
} from 'mediabunny';

async function open(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fixture request failed: ${response.status} ${url}`);
  return new Input({ source: new BlobSource(await response.blob()), formats: ALL_FORMATS });
}

async function capabilities() {
  return {
    adapter: 'reference-mediabunny',
    userAgent: navigator.userAgent,
    secureContext: isSecureContext,
    h264Encode: await canEncodeVideo('avc', { width: 320, height: 180, bitrate: 1_000_000 }),
    aacEncode: await canEncodeAudio('aac', { sampleRate: 48000, numberOfChannels: 2, bitrate: 192_000 }),
    opusEncode: await canEncodeAudio('opus', { sampleRate: 48000, numberOfChannels: 2, bitrate: 192_000 }),
  };
}

async function inspect(url: string, times: number[]) {
  const input = await open(url);
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video || !audio) throw new Error('Fixture must have video and audio');
    const canvas = document.createElement('canvas');
    canvas.width = await video.getDisplayWidth();
    canvas.height = await video.getDisplayHeight();
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const sink = new VideoSampleSink(video);
    const frames = [];
    for (const time of times) {
      const sample = await sink.getSample(time);
      if (!sample) throw new Error(`No frame at ${time}`);
      try {
        sample.draw(context, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let id = 0;
        for (let bit = 0; bit < 10; bit++) {
          if (pixels[(32 * canvas.width + 16 + bit * 24 + 12) * 4] > 128) id |= 1 << bit;
        }
        frames.push({ requested: time, timestamp: sample.timestamp, duration: sample.duration, id });
      } finally { sample.close(); }
    }
    return {
      metadataDuration: await input.getDurationFromMetadata(),
      scannedDuration: await input.computeDuration(),
      width: canvas.width, height: canvas.height,
      videoCodec: await video.getCodec(), audioCodec: await audio.getCodec(),
      sampleRate: await audio.getSampleRate(), channels: await audio.getNumberOfChannels(),
      videoCanDecode: await video.canDecode(), audioCanDecode: await audio.canDecode(), frames,
    };
  } finally { input.dispose(); }
}

async function decodeAudio(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Audio fixture request failed: ${response.status}`);
  const context = new AudioContext({ sampleRate: 48000 });
  try {
    const decoded = await context.decodeAudioData(await response.arrayBuffer());
    const channels = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const values = decoded.getChannelData(c);
      const bin = Math.round(decoded.sampleRate * 0.005);
      const starts: number[] = [];
      let active = false;
      for (let offset = 0; offset < values.length; offset += bin) {
        let sum = 0;
        const end = Math.min(offset + bin, values.length);
        for (let i = offset; i < end; i++) sum += values[i] ** 2;
        const next = Math.sqrt(sum / (end - offset)) > 0.1;
        if (next && !active) starts.push(offset / decoded.sampleRate);
        active = next;
      }
      channels.push(starts);
    }
    return {
      sampleCount: decoded.length, sampleRate: decoded.sampleRate,
      channels: decoded.numberOfChannels, duration: decoded.length / decoded.sampleRate,
      pulseStarts: channels, durationSource: 'decoded-samples',
    };
  } finally { await context.close(); }
}

type AudioMode = 'copy-aac' | 'encode-opus' | 'encode-aac';
async function roundTrip(url: string, audioMode: AudioMode) {
  const support = await capabilities();
  if (!support.h264Encode) throw new Error('H.264 encoding is unavailable in this browser');
  if (audioMode === 'encode-aac' && !support.aacEncode) throw new Error('Native AAC encoding is unavailable in this browser');
  if (audioMode === 'encode-opus' && !support.opusEncode) throw new Error('Native Opus encoding is unavailable in this browser');
  const input = await open(url);
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  try {
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video || !audio) throw new Error('Fixture must have video and audio');
    const videoSource = new VideoSampleSource({ codec: 'avc', bitrate: 1_000_000, latencyMode: 'quality' });
    const audioSource = audioMode === 'copy-aac'
      ? new EncodedAudioPacketSource('aac')
      : new AudioSampleSource({ codec: audioMode === 'encode-aac' ? 'aac' : 'opus', bitrate: 192_000 });
    output.addVideoTrack(videoSource, { frameRate: 30 });
    output.addAudioTrack(audioSource);
    await output.start();
    let videoFrames = 0;
    let audioSamples = 0;
    // Await each submission and release each decoded frame. No full-video pixel buffer.
    for await (const sample of new VideoSampleSink(video).samples()) {
      try { await videoSource.add(sample); videoFrames++; }
      finally { sample.close(); }
    }
    if (audioSource instanceof EncodedAudioPacketSource) {
      const decoderConfig = await audio.getDecoderConfig();
      if (!decoderConfig) throw new Error('Missing AAC decoder configuration');
      for await (const packet of new EncodedPacketSink(audio).packets()) {
        await audioSource.add(packet, { decoderConfig });
      }
    } else {
      for await (const sample of new AudioSampleSink(audio).samples()) {
        try { await audioSource.add(sample); audioSamples += sample.numberOfFrames; }
        finally { sample.close(); }
      }
    }
    await output.finalize();
    if (!target.buffer) throw new Error('No MP4 was produced');
    const link = document.createElement('a');
    const blobUrl = URL.createObjectURL(new Blob([target.buffer], { type: 'video/mp4' }));
    link.href = blobUrl;
    link.download = `${audioMode}.mp4`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
    return { videoFrames, audioSamples, audioMode, bytes: target.buffer.byteLength };
  } catch (error) {
    if (output.state !== 'finalized') await output.cancel();
    throw error;
  } finally { input.dispose(); }
}

const harness = { capabilities, inspect, decodeAudio, roundTrip };
declare global { interface Window { mediaHarness: typeof harness } }
window.mediaHarness = harness;
