// Explicit force-copy contract. Synthetic fixtures only; no user recordings are packaged.
import assert from 'node:assert/strict';
import { openAsBlob } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createServer } from 'node:https';
import { chromium } from '@playwright/test';
import { openVideoCopy } from '../dist/public.js';
import { ffmpeg } from './generate-fixtures.mjs';
const root=path.resolve('tests/tmp/video-copy-container');await mkdir(root,{recursive:true});
const probe=file=>JSON.parse(execFileSync(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-select_streams','v:0','-show_packets','-show_streams','-show_data_hash','sha256','-of','json',file]).toString());
const frames=file=>ffmpeg(['-i',file,'-an','-fps_mode','passthrough','-f','framemd5','-']).toString().split('\n').filter(x=>x&&!x.startsWith('#')).map(x=>x.split(',').at(-1).trim());
const files={};
for(const open of [false,true]){
 const file=files[open?'open':'closed']=path.join(root,open?'open.mp4':'closed.mp4');
 ffmpeg(['-f','lavfi','-i','testsrc2=size=160x96:rate=25:duration=8','-an','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-x264-params',`keyint=25:min-keyint=25:scenecut=0:bframes=2:repeat-headers=1:open-gop=${+open}`,file]);
}
const openBlob=await openAsBlob(files.open);
await assert.rejects(()=>openVideoCopy(openBlob,{validation:'anything'}),e=>e.code==='INVALID_ARGUMENT');
const strict=await openVideoCopy(openBlob);
try{await assert.rejects(()=>strict.inspect(),e=>e.diagnosticCode==='SYNC_IDR_MISMATCH'&&e.recoverableInContainer===true&&e.severity==='error');}finally{await strict.close();}
const reports=[];
for(const [name,file] of Object.entries(files)){
 const s=await openVideoCopy(await openAsBlob(file),{validation:'container'});
 try{
  const info=await s.inspect();assert.equal(info.validation,'container');assert.ok(info.boundaries.slice(0,-1).every(b=>b.kind==='sync'));
  assert.equal((await s.findBoundaries(1.1)).previous.kind,'sync');
  const plan=await s.plan({keepRanges:[{start:1,end:3},{start:4,end:8}],snap:'strict',audioSampleRate:48000});
  assert.ok(Object.isFrozen(plan.warnings)&&plan.warnings.every(Object.isFrozen));assert.ok(plan.warnings.length<=32);
  assert.equal(plan.audioSamples,288000);
  const other=await openVideoCopy(await openAsBlob(file));
  try{await assert.rejects(()=>other.exportMp4({plan}),e=>e.reason==='PLAN_MISMATCH');}finally{await other.close();}
  await assert.rejects(()=>s.exportMp4({plan:structuredClone(plan)}),e=>e.reason==='PLAN_MISMATCH');
  await assert.rejects(()=>s.exportMp4({plan,target:{kind:'blob',maxBytes:1}}),e=>e.code==='RESOURCE_LIMIT');
  let aborted=false,closed=false;
  const controller=new AbortController(),stream=new WritableStream({write(){},abort(){aborted=true;},close(){closed=true;}});
  await assert.rejects(()=>s.exportMp4({plan,target:{kind:'stream',stream},signal:controller.signal,onProgress:p=>{if(p.stage==='finalizing')controller.abort();}}),e=>e.code==='ABORTED');
  assert.equal(stream.locked,false);assert.ok(aborted&&!closed);
  const result=await s.exportMp4({plan});assert.deepEqual(result.warnings,plan.warnings);assert.equal(result.videoPackets,plan.videoPackets);
  const target=path.join(root,`${name}-copy.mp4`);await writeFile(target,Buffer.from(await result.blob.arrayBuffer()));
  const original=probe(file),actual=probe(target),expected=[];
  for(const r of plan.ranges){
   const from=original.packets.findIndex(p=>p.flags.includes('K')&&Math.abs(+p.pts_time-r.sourceStart)<1e-7);
   const to=original.packets.findIndex(p=>p.flags.includes('K')&&Math.abs(+p.pts_time-r.sourceEnd)<1e-7);
   const decodeSpan=original.packets.slice(from,to<0?undefined:to);
   const kept=decodeSpan.filter(p=>+p.pts_time>=r.sourceStart&&+p.pts_time<r.sourceEnd);
   assert.equal(r.omittedVideoPackets,decodeSpan.length-kept.length);
   expected.push(...kept.map(p=>({hash:p.data_hash,time:+p.pts_time-r.sourceStart+r.outputStart})));
  }
  assert.deepEqual(actual.packets.map(p=>p.data_hash),expected.map(p=>p.hash));
  actual.packets.forEach((p,i)=>assert.ok(Math.abs(+p.pts_time-expected[i].time)<1e-6));
  assert.ok(Math.abs(+actual.streams[0].duration-plan.duration)<1e-6);
  const decoder=spawnSync(process.env.FFMPEG_PATH||'ffmpeg',['-v','warning','-i',target,'-an','-f','null','-'],{encoding:'utf8'});
  assert.equal(decoder.status,0);await writeFile(path.join(root,`${name}-decoder.log`),decoder.stderr);
  if(name==='closed'){assert.equal(plan.omittedVideoPackets,0);const all=frames(file);assert.deepEqual(frames(target),[...all.slice(25,75),...all.slice(100)]);}
  else {assert.ok(plan.omittedVideoPackets>0);assert.ok(plan.adjustedVideoPackets>0);assert.ok(plan.warnings.some(w=>w.code==='SYNC_IDR_MISMATCH'&&w.count>1));}
  reports.push({name,packets:result.videoPackets,omitted:result.omittedVideoPackets,adjusted:result.adjustedVideoPackets,warnings:plan.warnings,decoderWarnings:decoder.stderr.trim()});
 }finally{await s.close();}
}
// A warning at 1s must not disable validation: damage a repeated SPS / NAL after 2s.
const original=await readFile(files.open),packets=probe(files.open).packets;
for(const kind of ['sps','pps','nal','description','timestamp']){
 const bytes=Buffer.from(original);let changed=false;
 if(kind==='description'){const at=bytes.indexOf('stsc');bytes.writeUInt32BE(2,at+20);changed=true;}
 else if(kind==='timestamp'){const at=bytes.indexOf('stts');assert.ok(at>0);bytes.writeUInt32BE(0,at+16);changed=true;}
 else for(const p of packets){if(+p.pts_time<2)continue;let at=+p.pos,end=at+(+p.size);
  if(kind==='nal'){bytes.writeUInt32BE(0xffffffff,at);changed=true;break;}
  while(at<end){const size=bytes.readUInt32BE(at);at+=4;if((bytes[at]&31)===(kind==='sps'?7:8)){bytes[at+size-1]^=1;changed=true;break;}at+=size;}
  if(changed)break;
 }
 assert.ok(changed,kind);const file=path.join(root,`late-${kind}.mp4`);await writeFile(file,bytes);
 const s=await openVideoCopy(await openAsBlob(file),{validation:'container'});
 try{await assert.rejects(()=>s.inspect(),e=>e.recoverableInContainer===false&&(['sps','pps','description'].includes(kind)?e.reason==='CONFIGURATION_CHANGE':kind==='timestamp'?e.reason==='TIMELINE':e.reason==='GOP_STRUCTURE'));}finally{await s.close();}
}
// Gaps test provides an actual frame-number discontinuity, not just its SPS permission flag.
const gap=path.resolve('tests/tmp/video-copy-gaps/discontinuous.mp4');
const gapSession=await openVideoCopy(await openAsBlob(gap),{validation:'container'});
try{const info=await gapSession.inspect();assert.ok(info.warnings.some(w=>w.code==='FRAME_NUMBER_DISCONTINUITY'));const plan=await gapSession.plan({keepRanges:[{start:0,end:info.endTime}],snap:'strict'});assert.equal((await gapSession.exportMp4({plan})).videoPackets,100);}finally{await gapSession.close();}
// Browser plugin not available. Exercise file:// example and public Worker offline.
const bundle=path.resolve(process.env.VIDEO_COPY_BUNDLE_DIR||'dist/browser');
let server,origin;
if(process.argv.includes('--https')){
 execFileSync('pwsh.exe',['-NoProfile','-Command',"$rsa=[System.Security.Cryptography.RSA]::Create(2048); $request=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost',$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1); $cert=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1),[DateTimeOffset]::UtcNow.AddDays(2)); [IO.File]::WriteAllText('tests/tmp/video-copy-container/cert.pem',$cert.ExportCertificatePem()); [IO.File]::WriteAllText('tests/tmp/video-copy-container/key.pem',$rsa.ExportPkcs8PrivateKeyPem()); $cert.Dispose(); $rsa.Dispose();"]);
 server=createServer({key:await readFile(path.join(root,'key.pem')),cert:await readFile(path.join(root,'cert.pem'))},async(req,res)=>{
  try{const file=path.resolve('.'+decodeURIComponent(new URL(req.url,'https://localhost').pathname));if(!file.startsWith(path.resolve('.')+path.sep))throw Error('path');res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`https://127.0.0.1:${server.address().port}`;
}
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{
 const context=await browser.newContext({offline:!origin,ignoreHTTPSErrors:!!origin}),page=await context.newPage(),errors=[],network=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(origin+'/'))network.push(r.url());});
 const example=path.join(bundle,'examples/video-copy/index.html');
 await page.goto(origin?origin+'/'+path.relative('.',example).replaceAll(path.sep,'/'):pathToFileURL(example).href);
 await page.evaluate(()=>{globalThis.VideoEncoder=undefined;globalThis.VideoDecoder=undefined;});
 assert.equal(await page.locator('#validation').inputValue(),'strict');
 await page.locator('#file').setInputFiles(files.open);await page.locator('#audio').selectOption('none');await page.locator('#ranges').fill('[{"start":1,"end":3},{"start":4,"end":8}]');
 await page.locator('#inspect').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('GOP_STRUCTURE'));
 assert.equal(await page.locator('#blob').isDisabled(),true);
 await page.locator('#validation').selectOption('container');assert.equal(await page.locator('#force-warning').isVisible(),true);
 await page.locator('#inspect').click();await page.locator('#blob:enabled').waitFor();
 assert.match(await page.locator('#status').textContent(),/PACKETS_OMITTED/);
 await page.locator('#blob').click();await page.locator('#download:visible').waitFor();
 const uiResult=JSON.parse(await page.locator('#status').textContent());assert.equal(uiResult.validation,'container');assert.equal(uiResult.videoPackets,reports.find(r=>r.name==='open').packets);
 await page.screenshot({path:path.join(root,'force-desktop.png'),fullPage:true});
 await page.locator('#lang').selectOption('en');await page.setViewportSize({width:390,height:844});
 assert.match(await page.locator('#force-warning').textContent(),/visual artifacts/);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:path.join(root,'force-mobile.png'),fullPage:true});
 const workerSource=await readFile(path.join(bundle,'browser-media-io-public.js'),'utf8');
 const workerResult=await page.evaluate(async source=>{
  const url=URL.createObjectURL(new Blob([source,`;onmessage=async e=>{let s;try{s=await BrowserMediaIOPublic.openVideoCopy(e.data,{validation:'container'});const p=await s.plan({keepRanges:[{start:1,end:3},{start:4,end:8}],snap:'strict'});const r=await s.exportMp4({plan:p});postMessage({packets:r.videoPackets,validation:r.validation});}catch(e){postMessage({error:e.message});}finally{await s?.close();}};`],{type:'text/javascript'}));
  const worker=new Worker(url);try{return await new Promise((resolve,reject)=>{worker.onmessage=e=>resolve(e.data);worker.onerror=e=>reject(Error(e.message));worker.postMessage(document.querySelector('#file').files[0]);});}finally{worker.terminate();URL.revokeObjectURL(url);}
 },workerSource);
 assert.equal(workerResult.validation,'container');assert.equal(workerResult.packets,uiResult.videoPackets);
 // PCM timing stays tied to the plan even when video packets are omitted at a cut.
 const audioResult=await page.evaluate(async()=>{
  const api=BrowserMediaIO,s=await api.openVideoCopy(document.querySelector('#file').files[0],{validation:'container'});
  try{
   await api.enableAacFallback({sampleRate:48000,channels:2,audioBitrate:80000});
   const plan=await s.plan({keepRanges:[{start:1,end:3},{start:4,end:8}],snap:'strict',audioSampleRate:48000});
   let returned=false;
   async function* blocks(){try{for(let at=0;at<plan.audioSamples;at+=4096){const length=Math.min(4096,plan.audioSamples-at),a=Float32Array.from({length},(_,i)=>{const t=(at+i)/48000;return [.25,2.1,5.7].some(m=>t>=m&&t<m+.08)?.5*Math.sin(2*Math.PI*1000*t):0;});yield{sampleRate:48000,numberOfChannels:2,length,channelData:[a,a]};}}finally{returned=true;}}
   const r=await s.exportMp4({plan,audio:{mode:'pcm',sampleRate:48000,channels:2,bitrate:80000,blocks}});
   const short=await s.exportMp4({plan,audio:{mode:'pcm',sampleRate:48000,channels:2,bitrate:80000,blocks:async function*(){}}}).then(()=>null,e=>e.reason);
   return{bytes:[...new Uint8Array(await r.blob.arrayBuffer())],samples:r.audioSamples,returned,short};
  }finally{await s.close();}
 });
 assert.equal(audioResult.samples,288000);assert.equal(audioResult.returned,true);assert.equal(audioResult.short,'PCM_LENGTH');
 const audioFile=path.join(root,'open-audio.mp4');await writeFile(audioFile,Buffer.from(audioResult.bytes));
 const pcm=ffmpeg(['-i',audioFile,'-map','0:a:0','-ac','1','-ar','48000','-f','f32le','-']),pulses=[];let active=false;
 for(let i=0;i<pcm.length/4-240;i+=240){let energy=0;for(let j=i;j<i+240;j++)energy+=pcm.readFloatLE(j*4)**2;const now=Math.sqrt(energy/240)>.1;if(now&&!active)pulses.push(i/48000);active=now;}
 assert.equal(pulses.length,3);[.25,2.1,5.7].forEach((t,i)=>assert.ok(Math.abs(pulses[i]-t)<=.025));
 reports.push({forceAudioSamples:audioResult.samples,pulses,shortPcm:audioResult.short});
 await page.locator('#validation').selectOption('strict');assert.equal(await page.locator('#blob').isDisabled(),true);assert.equal(await page.locator('#download').isVisible(),false);
 assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
 reports.push({browser:browser.version(),protocol:origin?'https:':'file:',worker:workerResult,pageErrors:errors,network});
}finally{await browser.close();await new Promise(resolve=>server?server.close(resolve):resolve());}
const browserName=/msedge/i.test(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||'')?'edge':'chrome';
await writeFile(path.join(root,`${browserName}${origin?'-https':''}.json`),JSON.stringify(reports,null,2)+'\n');
console.log('Passed: explicit force mode, packet payload/PTS, omissions/durations, late fatal errors, cleanup, offline UI and Worker.');
