import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'node:https';
import { ffmpeg, fixtureDir } from './generate-fixtures.mjs';
const root = path.resolve('tests/tmp/video-copy'); await mkdir(root, { recursive: true });
const bundleDir=path.resolve(process.env.VIDEO_COPY_BUNDLE_DIR||'dist/browser');
let server, origin;
if(process.argv.includes('--https')) {
  execFileSync('pwsh.exe',['-NoProfile','-Command',
    "$rsa=[System.Security.Cryptography.RSA]::Create(2048); $request=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost',$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1); $cert=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1),[DateTimeOffset]::UtcNow.AddDays(2)); [IO.File]::WriteAllText('tests/tmp/video-copy/cert.pem',$cert.ExportCertificatePem()); [IO.File]::WriteAllText('tests/tmp/video-copy/key.pem',$rsa.ExportPkcs8PrivateKeyPem()); $cert.Dispose(); $rsa.Dispose();" ]);
  server=createServer({key:await readFile(path.join(root,'key.pem')),cert:await readFile(path.join(root,'cert.pem'))},async(req,res)=>{
    try{const filename=path.resolve('.'+decodeURIComponent(new URL(req.url,'https://localhost').pathname));
      if(!filename.startsWith(path.resolve('.')+path.sep))throw Error('path');
      res.setHeader('Content-Type',filename.endsWith('.js')?'text/javascript':filename.endsWith('.html')?'text/html':'application/octet-stream');res.end(await readFile(filename));
    }catch{res.writeHead(404);res.end();}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`https://127.0.0.1:${server.address().port}`;
}
const pageUrl=file=>origin?origin+'/'+path.relative('.',file).replaceAll(path.sep,'/'):pathToFileURL(file).href;
const contextOptions={offline:!origin,ignoreHTTPSErrors:!!origin};
const avc = path.join(root, 'closed.mp4'), vfr = path.join(root, 'vfr.mp4'), openGop = path.join(root, 'open.mp4');
for (const [file, filter, extra] of [[avc, 'null', ''], [vfr, "select='if(lt(t,3),1,not(mod(n,2)))'", ''], [openGop, 'null', ':open-gop=1']]) {
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=25:duration=8', '-vf', filter, '-fps_mode', 'vfr', '-an', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', '-x264-params', `keyint=25:min-keyint=25:scenecut=0:bframes=2${extra}`, file]);
}
const rotated=path.join(root,'rotated.mp4'),aspect=path.join(root,'aspect.mp4');
const delayedAudio=path.join(root,'delayed-audio.mp4');
ffmpeg(['-i',avc,'-itsoffset','0.25','-f','lavfi','-i',"aevalsrc='if(between(t,1,1.1)+between(t,4,4.1)+between(t,7,7.1),0.5*sin(2*PI*1000*t),0)':s=48000:d=8",'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-ac','2','-b:a','80k',delayedAudio]);
ffmpeg(['-i',avc,'-c','copy','-metadata:s:v:0','rotate=90',rotated]);
ffmpeg(['-i',avc,'-vf','setsar=4/3','-c:v','libx264','-threads','2','-x264-params','keyint=25:min-keyint=25:scenecut=0:bframes=2','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709',aspect]);
const badSync=path.join(root,'bad-sync.mp4'),changedDescription=path.join(root,'changed-description.mp4');
const altered=Buffer.from(await readFile(avc)),sync=altered.indexOf('stss');assert.ok(sync>0);altered.writeUInt32BE(2,sync+12);await writeFile(badSync,altered);
const alteredDescription=Buffer.from(await readFile(avc)),sc=alteredDescription.indexOf('stsc');assert.ok(sc>0);alteredDescription.writeUInt32BE(2,sc+20);await writeFile(changedDescription,alteredDescription);
const fractional=path.join(root,'fractional.mp4');
ffmpeg(['-f','lavfi','-i','testsrc2=size=64x48:rate=30000/1001:duration=10','-c:v','libx264','-threads','2','-g','1','-bf','0',fractional]);
const probe = file => JSON.parse(execFileSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v','error','-select_streams','v:0','-show_packets','-show_streams','-show_data_hash','sha256','-of','json',file], { maxBuffer: 64*1024*1024 }).toString());
const frameHashes = file => ffmpeg(['-i', file, '-an', '-fps_mode','passthrough','-f','framemd5','pipe:1']).toString().split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').at(-1).trim());
await writeFile(path.join(root,'index.html'), `<!doctype html><meta charset="utf-8"><input id="file" type="file"><script src="${path.relative(root,path.join(bundleDir,'browser-media-io.js')).replaceAll(path.sep,'/')}"></script><script src="${path.relative(root,path.join(bundleDir,'examples/video-copy/pcm.js')).replaceAll(path.sep,'/')}"></script>`);
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const results=[];
try {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const errors=[], network=[];
  page.on('pageerror', e=>errors.push(e.message)); page.on('request', r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(origin+'/'))network.push(r.url());});
  await page.goto(pageUrl(path.join(root,'index.html')));
  await page.evaluate(()=>{globalThis.VideoEncoder=undefined;globalThis.VideoDecoder=undefined;});
  for(const file of [avc,vfr,rotated,aspect]) {
    await page.locator('#file').setInputFiles(file);
    const result = await page.evaluate(async()=>{
      const api=BrowserMediaIO, copy=await api.openVideoCopy(document.querySelector('#file').files[0]);
      try {
        const info=await copy.inspect();
        const plan=await copy.plan({keepRanges:[{start:info.boundaries[1].time,end:info.boundaries[3].time},{start:info.boundaries[4].time,end:info.endTime}],snap:'strict',audioSampleRate:48000});
        const full=await copy.plan({keepRanges:[{start:info.startTime,end:info.endTime}],snap:'strict'});
        const inside=await copy.plan({keepRanges:[{start:.1,end:3.9}],snap:'inside'});
        const empty=await copy.plan({keepRanges:[{start:.1,end:.2}],snap:'inside'}).then(()=>null,e=>({code:e.code,reason:e.reason,rangeIndex:e.rangeIndex}));
        const wrong=await copy.exportMp4({plan:structuredClone(plan)}).then(()=>null,e=>e.reason);
        const outputs=[];
        for(const p of [full,plan]) {const r=await copy.exportMp4({plan:p});outputs.push({plan:p,bytes:[...new Uint8Array(await r.blob.arrayBuffer())],packets:r.videoPackets});}
        return {info,plan,inside,empty,wrong,outputs};
      } finally {await copy.close();}
    });
    assert.equal(result.empty.reason,'EMPTY_RANGE'); assert.equal(result.empty.rangeIndex,0);assert.equal(result.wrong,'PLAN_MISMATCH');
    assert.ok(result.inside.ranges[0].sourceStart>=.1&&result.inside.ranges[0].sourceEnd<=3.9);
    const original=probe(file), decoded=frameHashes(file);
    for(const [index,out] of result.outputs.entries()) {
      const target=path.join(root,path.basename(file)+`-${index}.mp4`);await writeFile(target,Buffer.from(out.bytes));
      const actual=probe(target), expected=out.plan.ranges.flatMap(r=>original.packets.filter(p=>+p.pts_time>=r.sourceStart-1e-7&&+p.pts_time<r.sourceEnd-1e-7));
      for(const field of ['width','height','sample_aspect_ratio','display_aspect_ratio','color_space','color_transfer','color_primaries'])assert.equal(actual.streams[0][field],original.streams[0][field],field);
      assert.equal(actual.streams[0].side_data_list?.find(x=>x.rotation!==undefined)?.rotation,original.streams[0].side_data_list?.find(x=>x.rotation!==undefined)?.rotation);
      assert.deepEqual(actual.packets.map(p=>p.data_hash),expected.map(p=>p.data_hash),'Compressed payload/decode order');
      const expectedTimes=out.plan.ranges.flatMap(r=>original.packets.filter(p=>+p.pts_time>=r.sourceStart-1e-7&&+p.pts_time<r.sourceEnd-1e-7).map(p=>+p.pts_time-r.sourceStart+r.outputStart));
      actual.packets.forEach((p,i)=>assert.ok(Math.abs(+p.pts_time-expectedTimes[i])<1e-6,'Presentation timestamp'));
      const presentation=original.packets.map((p,i)=>({t:+p.pts_time,i})).sort((a,b)=>a.t-b.t);
      const expectedDecoded=out.plan.ranges.flatMap(r=>presentation.flatMap((p,i)=>p.t>=r.sourceStart-1e-7&&p.t<r.sourceEnd-1e-7?[decoded[i]]:[]));
      assert.deepEqual(frameHashes(target),expectedDecoded,'Independently decoded images');
      results.push({file:path.basename(file),range:index,packets:actual.packets.length,duration:out.plan.duration});
    }
  }
  await page.locator('#file').setInputFiles(openGop);
  const unsupported=await page.evaluate(async()=>{const s=await BrowserMediaIO.openVideoCopy(document.querySelector('#file').files[0]);try{return await s.inspect().then(()=>null,e=>({code:e.code,reason:e.reason}));}finally{await s.close();}});
  assert.deepEqual(unsupported,{code:'UNSUPPORTED',reason:'GOP_STRUCTURE'});
  for(const [file,reason] of [[badSync,'GOP_STRUCTURE'],[changedDescription,'CONFIGURATION_CHANGE']]) {
    await page.locator('#file').setInputFiles(file);
    const error=await page.evaluate(async()=>{const s=await BrowserMediaIO.openVideoCopy(document.querySelector('#file').files[0]);try{return await s.inspect().then(()=>null,e=>e.reason);}finally{await s.close();}});
    assert.equal(error,reason);
  }
  await page.locator('#file').setInputFiles(avc);
  const contracts=await page.evaluate(async()=>{
    const api=BrowserMediaIO,s=await api.openVideoCopy(document.querySelector('#file').files[0]),controller=new AbortController();
    try {
      const cancelled=await s.inspect({signal:controller.signal,onProgress:p=>{if(p.videoPackets>=128)controller.abort();}}).then(()=>null,e=>e.code);
      const info=await s.inspect(),invalid=[];
      for(const keepRanges of [[],[{start:2,end:1}],[{start:0,end:4},{start:3,end:5}],[{start:-1,end:2}],[{start:0,end:10}]])invalid.push(await s.plan({keepRanges,snap:'strict'}).then(()=>null,e=>e.reason));
      const p=await s.plan({keepRanges:[{start:0,end:1}],snap:'strict',audioSampleRate:44100});
      const snapshot=JSON.stringify(p);try{p.ranges[0].sourceStart=7;}catch{};
      const conflict=await s.exportMp4({plan:p,videoBitrate:10000}).then(()=>null,e=>e.reason);
      const other=await api.openVideoCopy(document.querySelector('#file').files[0]);let mismatch;
      try{mismatch=await other.exportMp4({plan:p}).then(()=>null,e=>e.reason);}finally{await other.close();}
      const near=await s.findBoundaries(.3);await s.close();const closed=await s.inspect().then(()=>null,e=>e.code);
      return{cancelled,invalid,unchanged:snapshot===JSON.stringify(p),conflict,mismatch,near,closed};
    }finally{await s.close();}
  });
  assert.equal(contracts.cancelled,'ABORTED');assert.ok(contracts.invalid.every(x=>x==='INVALID_RANGE'));assert.equal(contracts.unchanged,true);
  assert.equal(contracts.conflict,'CONFLICTING_OPTIONS');assert.equal(contracts.mismatch,'PLAN_MISMATCH');assert.equal(contracts.closed,'CLOSED');
  assert.equal(contracts.near.previous.time,0);assert.equal(contracts.near.next.time,1);results.push({contracts});
  await page.locator('#file').setInputFiles(fractional);
  const many=await page.evaluate(async()=>{
    const s=await BrowserMediaIO.openVideoCopy(document.querySelector('#file').files[0]);
    try{const info=await s.inspect(),keepRanges=info.boundaries.flatMap((b,i)=>i%3===0&&i+1<info.boundaries.length?[{start:b.time,end:info.boundaries[i+1].time}]:[]);
      const plan=await s.plan({keepRanges,snap:'strict',audioSampleRate:44100}),r=await s.exportMp4({plan});return{plan,bytes:r.bytes,packets:r.videoPackets};
    }finally{await s.close();}
  });
  assert.ok(many.plan.ranges.length>=99);assert.equal(many.plan.audioSamples,Math.round(many.plan.duration*44100));
  assert.equal(many.plan.ranges.reduce((n,r)=>n+r.audioSamples,0),many.plan.audioSamples);
  many.plan.ranges.forEach(r=>assert.ok(Math.abs(r.audioEndSample-r.outputEnd*44100)<=.5+1e-8));
  results.push({manyRanges:many.plan.ranges.length,totalSamples:many.plan.audioSamples,duration:many.plan.duration});
  await page.locator('#file').setInputFiles(avc);
  const workerSource=await readFile(path.join(bundleDir,'browser-media-io-public.js'),'utf8');
  const workerResult=await page.evaluate(async source=>{
    const url=URL.createObjectURL(new Blob([source,`;globalThis.VideoEncoder=undefined;globalThis.VideoDecoder=undefined;onmessage=async e=>{let s;try{s=await BrowserMediaIOPublic.openVideoCopy(e.data);const p=await s.plan({keepRanges:[{start:1,end:3}],snap:'strict'});const r=await s.exportMp4({plan:p});postMessage({packets:r.videoPackets,bytes:r.bytes});}catch(e){postMessage({error:e.message});}finally{await s?.close();}};`],{type:'text/javascript'}));
    const worker=new Worker(url);try{return await new Promise((resolve,reject)=>{worker.onmessage=e=>resolve(e.data);worker.onerror=e=>reject(Error(e.message));worker.postMessage(document.querySelector('#file').files[0]);});}finally{worker.terminate();URL.revokeObjectURL(url);}
  },workerSource);
  assert.equal(workerResult.packets,50);assert.ok(workerResult.bytes>0);results.push({publicWorker:workerResult});
  assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
  for(const [wasm,bitrate] of [[false,80000],[true,80000],[false,192000]]) {
    const audioContext=await browser.newContext(contextOptions);
    if(wasm)await audioContext.addInitScript(()=>{const original=AudioEncoder.isConfigSupported.bind(AudioEncoder);AudioEncoder.isConfigSupported=c=>c.codec.startsWith('mp4a')?Promise.resolve({supported:false,config:c}):original(c);});
    const ap=await audioContext.newPage();await ap.goto(pageUrl(path.join(root,'index.html')));
    await ap.locator('#file').setInputFiles(avc);
    const target=path.join(root,`audio-${wasm?'wasm':'auto'}-${bitrate}.mp4`), handle=await open(target,'w');let closed=false,aborted=false,writes=0;
    await ap.exposeFunction('writeOutput',async({data,position})=>{writes++;await handle.write(Buffer.from(data,'base64'),0,Buffer.byteLength(data,'base64'),position);});
    await ap.exposeFunction('closeOutput',async()=>{closed=true;await handle.close();});
    await ap.exposeFunction('abortOutput',async()=>{aborted=true;await handle.close();});
    const audioResult=await ap.evaluate(async bitrate=>{
      const api=BrowserMediaIO,backend=await api.enableAacFallback({sampleRate:48000,channels:2,audioBitrate:bitrate});
      globalThis.VideoEncoder=undefined;globalThis.VideoDecoder=undefined;
      const s=await api.openVideoCopy(document.querySelector('#file').files[0]);
      try {
        const plan=await s.plan({keepRanges:[{start:1,end:3},{start:4,end:8}],snap:'strict',audioSampleRate:48000});
        const markers=[.25,1.9,2.1,5.7];let returned=false,reads=0;
        async function* blocks(signal){try{for(let start=0;start<plan.audioSamples;start+=4096){if(signal.aborted)throw Error('cancelled');reads++;
          const length=Math.min(4096,plan.audioSamples-start),channelData=[0,1].map(ch=>Float32Array.from({length},(_,i)=>{
            const t=(start+i)/48000;return markers.some(m=>t>=m&&t<m+.08)?.5*Math.sin(2*Math.PI*(ch?1700:1000)*t):0;}));
          yield {sampleRate:48000,numberOfChannels:2,length,channelData};
        }}finally{returned=true;}}
        const stream=new WritableStream({write:async({data,position})=>{let binary='';for(let i=0;i<data.length;i+=8192)binary+=String.fromCharCode(...data.subarray(i,i+8192));await writeOutput({data:btoa(binary),position});},close:()=>closeOutput(),abort:()=>abortOutput()});
        const progress=[];
        const result=await s.exportMp4({plan,audio:{mode:'pcm',sampleRate:48000,channels:2,bitrate,blocks},target:{kind:'stream',stream},onProgress:p=>progress.push(p)});
        return {backend,returned,reads,locked:stream.locked,result:{...result,blob:undefined},progress,markers};
      } finally {await s.close();}
    },bitrate);
    assert.ok(closed&&!aborted&&writes>0);assert.equal(audioResult.locked,false);assert.equal(audioResult.returned,true);assert.equal(audioResult.progress.at(-1).fraction,1);
    const pcm=ffmpeg(['-i',target,'-map','0:a:0','-ar','48000','-ac','2','-f','f32le','pipe:1']);
    const pulses=[];let active=false;
    for(let i=0;i<pcm.length/8-240;i+=240){let energy=0;for(let j=i;j<i+240;j++)energy+=pcm.readFloatLE(j*8)**2;const now=Math.sqrt(energy/240)>.1;if(now&&!active)pulses.push(i/48000);active=now;}
    assert.equal(pulses.length,audioResult.markers.length);
    pulses.forEach((t,i)=>assert.ok(Math.abs(t-audioResult.markers[i])<=.025,`AAC timing ${audioResult.backend}: ${t} != ${audioResult.markers[i]}`));
    const videoProbe=probe(target),videoExpected=probe(avc).packets.filter(p=>+p.pts_time>=1&&+p.pts_time<3||+p.pts_time>=4);
    assert.deepEqual(videoProbe.packets.map(p=>p.data_hash),videoExpected.map(p=>p.data_hash));
    const summary=JSON.parse(execFileSync(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-show_streams','-show_format','-of','json',target]).toString());
    assert.ok(Math.abs(+summary.format.duration-6)<1/48000);
    assert.ok(Math.abs(pcm.length/8-audioResult.result.audioSamples)<=1024);
    assert.deepEqual(summary.streams.find(s=>s.codec_type==='audio')&&[summary.streams[1].codec_name,summary.streams[1].sample_rate,summary.streams[1].channels],['aac','48000',2]);
    results.push({audioBackend:audioResult.backend,bitrate,pulses,decodedSamples:pcm.length/8,plannedSamples:audioResult.result.audioSamples,streamWrites:writes});
    // Failure paths must abort/release the destination and return the PCM iterator.
    const failureCases=await ap.evaluate(async bitrate=>{
      const api=BrowserMediaIO,s=await api.openVideoCopy(document.querySelector('#file').files[0]),out=[];
      try {
        const plan=await s.plan({keepRanges:[{start:1,end:3}],snap:'strict',audioSampleRate:48000});
        for(const mode of ['short','long','rate','nan','cancel','init','write','finalize','limit']) {
          let returned=false,closed=false,aborted=false;const controller=new AbortController();
          const stream=new WritableStream({write(){if(mode==='write')throw Error('disk full');},close(){closed=true;},abort(){aborted=true;}});
          async function* blocks(signal){try{const total=plan.audioSamples+(mode==='short'?-1:mode==='long'?1:0);
            for(let i=0;i<total;i+=4096){if(mode==='init'&&i===0)setTimeout(()=>controller.abort(),0);if(mode==='cancel'&&i>0){controller.abort();await new Promise(r=>setTimeout(r,1));}
              const length=Math.min(4096,total-i),a=new Float32Array(length);if(mode==='nan')a[0]=NaN;
              yield {sampleRate:mode==='rate'?44100:48000,numberOfChannels:2,length,channelData:[a,a]};}
          }finally{returned=true;}}
          const code=await s.exportMp4({plan,audio:{mode:'pcm',sampleRate:48000,channels:2,bitrate,blocks},signal:controller.signal,
            target:mode==='limit'?{kind:'blob',maxBytes:1}:{kind:'stream',stream},onProgress:p=>{if(mode==='finalize'&&p.stage==='finalizing')controller.abort();}}).then(()=>({code:'unexpected'}),e=>({code:e.code,reason:e.reason}));
          out.push({mode,...code,returned,closed,aborted,locked:stream.locked});
        }
        const retry=await s.exportMp4({plan});out.push({mode:'retry',bytes:retry.bytes});return out;
      }finally{await s.close();}
    },bitrate);
    for(const f of failureCases.filter(x=>x.mode!=='retry')) {
      assert.notEqual(f.code,'unexpected',f.mode);assert.equal(f.returned,true,f.mode);assert.equal(f.locked,false,f.mode);assert.equal(f.closed,false,f.mode);
      if(!['write','limit'].includes(f.mode))assert.equal(f.aborted,true,f.mode);
      if(['short','long'].includes(f.mode))assert.equal(f.reason,'PCM_LENGTH');
      if(['cancel','init','finalize'].includes(f.mode))assert.equal(f.code,'ABORTED');
    }
    assert.ok(failureCases.at(-1).bytes>0);results.push({failureCases});
    await audioContext.close();
  }
  const alignedContext=await browser.newContext(contextOptions),aligned=await alignedContext.newPage();
  await aligned.goto(pageUrl(path.join(root,'index.html')));await aligned.locator('#file').setInputFiles(delayedAudio);
  const alignedResult=await aligned.evaluate(async()=>{
    const api=BrowserMediaIO,file=document.querySelector('#file').files[0],s=await api.openVideoCopy(file),input=await api.openMedia(file);
    try {
      const plan=await s.plan({keepRanges:[{start:0,end:2},{start:4,end:8}],snap:'strict',audioSampleRate:48000});
      await api.enableAacFallback({sampleRate:48000,channels:2,audioBitrate:80000});
      const result=await s.exportMp4({plan,audio:{mode:'pcm',sampleRate:48000,channels:2,bitrate:80000,
        blocks:signal=>VideoCopyExample.pcm(input,plan,2,signal,async block=>{for(const a of block.channelData)for(let i=0;i<a.length;i++)a[i]*=.5;return block;})}});
      let direct;
      try {
        const directory=await navigator.storage.getDirectory(),handle=await directory.getFileHandle('video-copy-test.mp4',{create:true}),stream=await handle.createWritable();
        const saved=await s.exportMp4({plan,target:{kind:'stream',stream}}),file=await handle.getFile();
        direct={supported:true,size:file.size,bytes:saved.bytes,locked:stream.locked};await directory.removeEntry('video-copy-test.mp4');
      }catch(e){direct={supported:false,error:e.name+': '+e.message};}
      return{bytes:[...new Uint8Array(await result.blob.arrayBuffer())],direct};
    }finally{input.close();await s.close();}
  });
  const alignedFile=path.join(root,'aligned-audio.mp4');await writeFile(alignedFile,Buffer.from(alignedResult.bytes));
  const alignedPcm=ffmpeg(['-i',alignedFile,'-map','0:a:0','-ac','1','-ar','48000','-f','f32le','pipe:1']);
  const alignedPulses=[];let wasActive=false,maxAmplitude=0;
  for(let i=0;i<alignedPcm.length/4-240;i+=240){let e=0;for(let j=i;j<i+240;j++){const v=alignedPcm.readFloatLE(j*4);e+=v*v;maxAmplitude=Math.max(maxAmplitude,Math.abs(v));}const now=Math.sqrt(e/240)>.05;if(now&&!wasActive)alignedPulses.push(i/48000);wasActive=now;}
  assert.equal(alignedPulses.length,3);[1.25,2.25,5.25].forEach((t,i)=>assert.ok(Math.abs(t-alignedPulses[i])<.025));
  assert.ok(maxAmplitude>.15&&maxAmplitude<.35);
  if(origin){assert.equal(alignedResult.direct.supported,true);assert.equal(alignedResult.direct.size,alignedResult.direct.bytes);assert.equal(alignedResult.direct.locked,false);}
  results.push({alignedPulses,maxAmplitude,fileSystemStream:alignedResult.direct});await alignedContext.close();
  // Browser plugin not available: exercise the distributed example with Playwright.
  const ui=await browser.newContext(contextOptions),uiPage=await ui.newPage();
  await uiPage.goto(pageUrl(path.join(bundleDir,'examples/video-copy/index.html')));
  assert.equal(await uiPage.title(),'Browser Media I/O — Video copy');
  await uiPage.locator('#lang').selectOption('en');assert.match(await uiPage.locator('h1').textContent(),/without re-encoding/);
  await uiPage.locator('#file').setInputFiles(avc);await uiPage.locator('#audio').selectOption('none');
  await uiPage.locator('#ranges').fill('[{"start":0.1,"end":7.9}]');await uiPage.locator('#inspect').click();
  await uiPage.locator('#blob:enabled').waitFor();await uiPage.locator('#blob').click();await uiPage.locator('#download:visible').waitFor();
  assert.match(await uiPage.locator('#status').textContent(),/"videoMode": "copy"/);
  await uiPage.locator('#preview').evaluate(v=>new Promise((resolve,reject)=>{if(v.readyState>=2)return resolve();v.onloadeddata=resolve;v.onerror=()=>reject(Error('preview failed'));}));
  await uiPage.locator('#preview').evaluate(async v=>{v.muted=true;await v.play();});
  await uiPage.waitForFunction(()=>document.querySelector('#preview').currentTime>.1);
  await uiPage.locator('#preview').evaluate(v=>v.pause());
  await uiPage.screenshot({path:path.join(root,'example-desktop.png'),fullPage:true});
  await uiPage.setViewportSize({width:390,height:844});await uiPage.locator('#lang').selectOption('ja');
  assert.ok(await uiPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await uiPage.screenshot({path:path.join(root,'example-mobile.png'),fullPage:true});await ui.close();
  const report={browser:browser.version(),protocol:origin?'https:':'file:',results,openGop:unsupported};
  await writeFile(path.join(root,`${/msedge/i.test(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||'')?'edge':'chrome'}${origin?'-https':''}.json`),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {await browser.close();await new Promise(resolve=>server?server.close(resolve):resolve());}
