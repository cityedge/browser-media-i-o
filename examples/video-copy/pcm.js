// Application-side example: align timestamped decoded PCM to a confirmed copy plan.
// No resampling/downmixing. Select the source audio rate/channel count when planning.
globalThis.VideoCopyExample = {
  async *pcm(input, plan, channels, signal, process = async block => block) {
    const rate = plan.audioSampleRate;
    if (!rate) throw new Error('Plan requires audioSampleRate.');
    for (const range of plan.ranges) {
      const reader = input.audioPcmBlocks({ start: range.sourceStart, end: range.sourceEnd, maxBlockSamples: 4096, signal });
      const sourceBase = Math.round(range.sourceStart * rate);
      let current, done = false;
      try {
        for (let cursor = 0; cursor < range.audioSamples;) {
          if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
          const length = Math.min(4096, range.audioSamples - cursor);
          const channelData = Array.from({ length: channels }, () => new Float32Array(length));
          let written = 0;
          while (written < length) {
            const at = sourceBase + cursor + written;
            if (!current && !done) { const next = await reader.next(); done = next.done; current = next.value; }
            if (done && !current) break; // Missing source audio is explicit silence in this application example.
            if (current.sampleRate !== rate || current.numberOfChannels !== channels) throw new Error('Source PCM configuration changed; resample in the application first.');
            const first = Math.round(current.timestamp * rate), last = first + current.length;
            if (last <= at) { current = undefined; continue; }
            if (first > at) { written += Math.min(length - written, first - at); continue; }
            const from = at - first, count = Math.min(length - written, current.length - from);
            for (let ch = 0; ch < channels; ch++) channelData[ch].set(current.channelData[ch].subarray(from, from + count), written);
            written += count;
            if (from + count === current.length) current = undefined;
          }
          const block = { sampleRate: rate, numberOfChannels: channels, length, channelData };
          // Leveling/limiting belongs here, after analyzing the same confirmed plan.
          yield await process(block, signal, range.audioStartSample + cursor);
          cursor += length;
        }
      } finally { await reader.return(); }
    }
  },
};
