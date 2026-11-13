// Optional private-media acceptance test. Input is read-only and is never included in releases.
import assert from 'node:assert/strict';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const input = process.argv[2];
if (!input) throw Error('Usage: node scripts/test-video-copy-zoom.mjs <input.mp4> [--short] [--container]');
const short = process.argv.includes('--short');
const validation = process.argv.includes('--container') ? 'container' : 'strict';
const browserName = /msedge/i.test(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '') ? 'edge' : 'chrome';
const root = path.resolve(`tests/tmp/zoom-copy-${browserName}${short ? '-short' : ''}${validation === 'container' ? '-container' : ''}`);
const bundle = path.resolve(process.env.VIDEO_COPY_BUNDLE_DIR || 'dist/browser');
await mkdir(root, { recursive: true });
await writeFile(path.join(root, 'index.html'), `<!doctype html><meta charset="utf-8"><input id="file" type="file"><script src="${path.relative(root, path.join(bundle, 'browser-media-io.js')).replaceAll(path.sep, '/')}"></script><script src="${path.relative(root, path.join(bundle, 'examples/video-copy/pcm.js')).replaceAll(path.sep, '/')}"></script>`);
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { maxBuffer: 128 * 1024 * 1024, ...options });
const ffprobe = args => JSON.parse(run(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', ...args, '-of', 'json']).toString());
const packetInfo = file => ffprobe(['-select_streams', 'v:0', '-show_packets', '-show_data_hash', 'sha256', file]).packets;
const videoInfo = file => ffprobe(['-select_streams', 'v:0', '-show_streams', file]).streams[0];
const ffmpeg = args => run(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-nostdin', ...args]);
const frameHashes = (file, at) => ffmpeg(['-ss', String(at), '-i', file, '-t', '0.4', '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'framemd5', '-']).toString().split('\n').filter(x => x && !x.startsWith('#')).map(x => x.split(',').at(-1).trim());
const originalPackets = packetInfo(input), originalVideo = videoInfo(input);
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const results = [];
try {
  const context = await browser.newContext({ offline: true });
  const page = await context.newPage(), errors = [], network = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (/^https?:/.test(r.url())) network.push(r.url()); });
  page.on('console', m => { if (m.text().startsWith('zoom:')) console.log(m.text()); });
  await page.goto(pathToFileURL(path.join(root, 'index.html')).href);
  await page.locator('#file').setInputFiles(path.resolve(input));
  await page.evaluate(async validation => {
    globalThis.VideoEncoder = undefined; globalThis.VideoDecoder = undefined;
    globalThis.copy = await BrowserMediaIO.openVideoCopy(document.querySelector('#file').files[0], {validation});
    globalThis.info = await copy.inspect();
  }, validation);
  const info = await page.evaluate(() => ({ ...info, boundaries: info.boundaries.map(b => ({time:b.time,kind:b.kind})) }));
  assert.equal(info.videoPackets, originalPackets.length);
  assert.equal(info.validation, validation);
  assert.ok(info.boundaries.slice(0,-1).every(b=>b.kind === (validation==='container'?'sync':'idr')));
  for (const mode of short ? ['audio'] : ['full', 'audio']) {
    const outputPath = path.join(root, `${mode}.mp4`), handle = await open(outputPath, 'w');
    let closed = false, aborted = false, writes = 0;
    await page.exposeFunction(`write_${mode}`, async ({ data, position }) => { const b=Buffer.from(data,'base64'); await handle.write(b,0,b.length,position);writes++; });
    await page.exposeFunction(`close_${mode}`, async () => { await handle.close();closed=true; });
    await page.exposeFunction(`abort_${mode}`, async () => { await handle.close();aborted=true; });
    let result;
    try {
      result = await page.evaluate(async ({mode,short}) => {
        const api=BrowserMediaIO, t=performance.now(), file=document.querySelector('#file').files[0];
        const ranges=mode==='full' ? [{start:info.startTime,end:info.endTime}]
          : short ? [{start:30,end:100},{start:2400,end:2470},{start:4800,end:info.endTime}]
          : [{start:1,end:1200},{start:1230,end:3600},{start:3630,end:info.endTime}];
        const plan=await copy.plan({keepRanges:ranges,snap:'inside',audioSampleRate:48000});
        const stream=new WritableStream({write:async({data,position})=>{
          let binary='';for(let i=0;i<data.length;i+=8192)binary+=String.fromCharCode(...data.subarray(i,i+8192));
          await globalThis[`write_${mode}`]({data:btoa(binary),position});
        },close:()=>globalThis[`close_${mode}`](),abort:()=>globalThis[`abort_${mode}`]()});
        let input, audio, backend=null;
        if(mode==='audio'){
          backend=await api.enableAacFallback({sampleRate:48000,channels:2,audioBitrate:80000});
          input=await api.openMedia(file);
          audio={mode:'pcm',sampleRate:48000,channels:2,bitrate:80000,blocks:signal=>VideoCopyExample.pcm(input,plan,2,signal,async b=>{
            for(const a of b.channelData)for(let i=0;i<a.length;i++)a[i]*=.5;return b;
          })};
        }
        let last=-1;
        try {
          const r=await copy.exportMp4({plan,audio,target:{kind:'stream',stream},onProgress:p=>{
            const percent=Math.floor((p.fraction||0)*10);if(percent!==last){last=percent;console.log(`zoom: ${mode} ${percent*10}% ${p.stage}`);}
          }});
          return {...r,backend,locked:stream.locked,elapsedMs:performance.now()-t};
        }finally{input?.close();}
      },{mode,short});
    } finally { if(!closed&&!aborted)await handle.close(); }
    assert.ok(closed&&!aborted&&writes>0);assert.equal(result.locked,false);
    const actual=packetInfo(outputPath), expected=result.plan.ranges.flatMap(r=>originalPackets.filter(p=>+p.pts_time>=r.sourceStart-1e-7&&+p.pts_time<r.sourceEnd-1e-7));
    assert.deepEqual(actual.map(p=>p.data_hash),expected.map(p=>p.data_hash),'All retained video packet payloads');
    const expectedTimes=result.plan.ranges.flatMap(r=>originalPackets.filter(p=>+p.pts_time>=r.sourceStart-1e-7&&+p.pts_time<r.sourceEnd-1e-7).map(p=>+p.pts_time-r.sourceStart+r.outputStart));
    actual.forEach((p,i)=>assert.ok(Math.abs(+p.pts_time-expectedTimes[i])<1e-6,'PTS'));
    const v=videoInfo(outputPath);
    for(const field of ['width','height','sample_aspect_ratio','color_range','color_space','color_transfer','color_primaries']) assert.equal(v[field],originalVideo[field],field);
    const frames=[];
    for(const range of result.plan.ranges)for(const delta of [0,(range.sourceEnd-range.sourceStart)/2,range.sourceEnd-range.sourceStart-1]){
      const d=Math.floor(delta*25)/25;const original=frameHashes(input,range.sourceStart+d),output=frameHashes(outputPath,range.outputStart+d);
      assert.ok(original.length>0);assert.deepEqual(output,original,'Decoded frames at start/middle/end');frames.push({sourceTime:range.sourceStart+d,outputTime:range.outputStart+d,frames:output.length});
    }
    const audioChecks=[];
    if(mode==='audio') {
      assert.equal(result.audioSamples,result.plan.audioSamples);
      const a=ffprobe(['-show_streams','-show_format',outputPath]);
      assert.ok(Math.abs(+a.format.duration-result.duration)<1/48000);
      const audio=a.streams.find(s=>s.codec_type==='audio');assert.equal(audio.sample_rate,'48000');assert.equal(audio.channels,2);
      for(const r of result.plan.ranges){
        // Independent waveforms, no meeting content is printed. Compare the application gain and audio alignment.
        const decode=(file,at)=>ffmpeg(['-ss',String(at),'-i',file,'-t','3','-map','0:a:0','-ac','1','-ar','48000','-f','f32le','-']);
        const source=decode(input,r.sourceStart+1),output=decode(outputPath,r.outputStart+1),n=Math.min(source.length,output.length)/4;
        let xx=0,xy=0,yy=0;for(let i=0;i<n;i++){const x=source.readFloatLE(i*4),y=output.readFloatLE(i*4);xx+=x*x;xy+=x*y;yy+=y*y;}
        const correlation=xx&&yy?xy/Math.sqrt(xx*yy):null,gain=xx?Math.sqrt(yy/xx):null;
        if(xx/n>1e-8){assert.ok(correlation>.8,`Audio alignment: ${correlation}`);assert.ok(gain>.35&&gain<.65,`Application gain: ${gain}`);}
        audioChecks.push({sourceTime:r.sourceStart+1,correlation,gain,signalRms:Math.sqrt(xx/n)});
      }
    }
    results.push({mode,...result,frames,audioChecks,writes});
    await writeFile(path.join(root,'result.json'),JSON.stringify({browser:browser.version(),videoPackets:info.videoPackets,duration:info.endTime,keyframeInterval:info.keyframeInterval,results},null,2)+'\n');
    console.log(`zoom: verified ${mode}: ${actual.length} payloads, ${frames.length} frame windows`);
  }
  await page.evaluate(()=>copy.close());assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
} finally {await browser.close();}
