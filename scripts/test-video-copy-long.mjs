import assert from 'node:assert/strict';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { ffmpeg } from './generate-fixtures.mjs';
const root=path.resolve('tests/tmp/video-copy-long');await mkdir(root,{recursive:true});
const input=path.join(root,'two-hours.mp4'),target=path.join(root,'two-hours-cut.mp4');
ffmpeg(['-f','lavfi','-i','color=c=black:size=160x96:rate=25:duration=7200','-vf',"drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(t,60),0.2)'",'-c:v','libx264','-preset','ultrafast','-threads','2','-x264-params','keyint=250:min-keyint=250:scenecut=0:bframes=2','-an',input],{timeout:180000});
await writeFile(path.join(root,'index.html'),'<!doctype html><meta charset="utf-8"><input id="file" type="file"><script src="../../../dist/browser/browser-media-io.js"></script>');
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const handle=await open(target,'w');let closed=false,writes=0;
const heapSamples=[];let timer,sampling=Promise.resolve();
try {
  const page=await browser.newPage({offline:true});
  const cdp=await page.context().newCDPSession(page),epoch=Date.now();
  timer=setInterval(()=>{sampling=sampling.then(async()=>heapSamples.push({elapsedMs:Date.now()-epoch,...await cdp.send('Runtime.getHeapUsage')})).catch(()=>{});},1000);
  page.on('console',m=>{if(m.text().startsWith('copy-long:'))console.log(m.text());});
  await page.exposeFunction('writeOutput',async({base64,position})=>{const b=Buffer.from(base64,'base64');await handle.write(b,0,b.length,position);writes++;});
  await page.exposeFunction('closeOutput',async()=>{await handle.close();closed=true;});
  await page.goto(pathToFileURL(path.join(root,'index.html')).href);await page.locator('#file').setInputFiles(input);
  const report=await page.evaluate(async()=>{
    const api=BrowserMediaIO,started=performance.now(),memory=[];
    const backend=await api.enableAacFallback({sampleRate:48000,channels:2,audioBitrate:80000});
    globalThis.VideoDecoder=undefined;globalThis.VideoEncoder=undefined;
    const s=await api.openVideoCopy(document.querySelector('#file').files[0]);
    try {
      const info=await s.inspect();console.log('copy-long: inspected '+info.videoPackets+' packets');
      const plan=await s.plan({keepRanges:[{start:0,end:1800},{start:1810,end:3600},{start:3610,end:7200}],snap:'strict',audioSampleRate:48000});
      let returned=false,rangeIndex=0,lastLog=-1,maxBlock=0;
      const tone=Float32Array.from({length:48},(_,i)=>.5*Math.sin(2*Math.PI*i/48));
      async function* blocks(signal){try{for(let start=0;start<plan.audioSamples;start+=4096){if(signal.aborted)throw Error('cancelled');
        const length=Math.min(4096,plan.audioSamples-start),samples=new Float32Array(length);maxBlock=Math.max(maxBlock,length);
        for(let i=0;i<length;i++){const sample=start+i;while(sample>=plan.ranges[rangeIndex].audioEndSample)rangeIndex++;const r=plan.ranges[rangeIndex];
          const sourceSample=Math.round(r.sourceStart*48000)+sample-r.audioStartSample;
          if(sourceSample%(60*48000)<.2*48000)samples[i]=tone[sourceSample%48];}
        yield{sampleRate:48000,numberOfChannels:2,length,channelData:[samples,samples]};
      }}finally{returned=true;}}
      const stream=new WritableStream({async write({data,position}){let text='';for(let i=0;i<data.length;i+=8192)text+=String.fromCharCode(...data.subarray(i,i+8192));await writeOutput({base64:btoa(text),position});},close:()=>closeOutput(),abort:()=>closeOutput()});
      const result=await s.exportMp4({plan,audio:{mode:'pcm',sampleRate:48000,channels:2,bitrate:80000,blocks},target:{kind:'stream',stream},onProgress:p=>{
        const step=Math.floor(p.audioSamples/48000/600);if(step!==lastLog){lastLog=step;memory.push({seconds:p.audioSamples/48000,heap:performance.memory?.usedJSHeapSize,totalHeap:performance.memory?.totalJSHeapSize});console.log('copy-long: '+(p.fraction*100).toFixed(1)+'%');}
      }});
      return{browser:navigator.userAgent,backend,elapsedMs:performance.now()-started,info:{packets:info.videoPackets,duration:info.endTime},plan,result:{...result,blob:undefined},memory,maxBlock,returned,locked:stream.locked};
    }finally{await s.close();}
  });
  assert.ok(closed&&writes>1);assert.equal(report.returned,true);assert.equal(report.locked,false);assert.equal(report.maxBlock,4096);
  assert.equal(report.result.duration,7180);assert.equal(report.result.audioSamples,7180*48000);
  const metadata=JSON.parse(execFileSync(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-show_format','-show_streams','-of','json',target]).toString());
  clearInterval(timer);await sampling;
  await writeFile(path.join(root,'export-result.json'),JSON.stringify({...report,heapSamples,writes,bytes:+metadata.format.size},null,2)+'\n');
  assert.ok(Math.abs(+metadata.format.duration-7180)<1/48000);
  const checks=[];
  for(const sourceSecond of [0,1800-60,1860,3540,3660,7140]) {
    const range=report.plan.ranges.find(r=>sourceSecond>=r.sourceStart&&sourceSecond<r.sourceEnd),time=range.outputStart+sourceSecond-range.sourceStart;
    const pcm=ffmpeg(['-ss',String(Math.max(0,time-.1)),'-i',target,'-t','0.5','-map','0:a:0','-ar','48000','-ac','1','-f','f32le','pipe:1']);
    let pulse=-1;for(let i=0;i<pcm.length/4;i++)if(Math.abs(pcm.readFloatLE(i*4))>.2){pulse=i/48000+Math.max(0,time-.1);break;}
    assert.ok(Math.abs(pulse-time)<.025,`long audio marker at ${time}: ${pulse}`);
    const gray=ffmpeg(['-ss',String(time),'-i',target,'-frames:v','1','-an','-pix_fmt','gray','-f','rawvideo','pipe:1']);
    assert.ok(gray[0]>200,`long video marker at ${time}`);checks.push({sourceSecond,outputSecond:time,audioMarker:pulse,videoGray:gray[0]});
  }
  await writeFile(path.join(root,'result.json'),JSON.stringify({...report,heapSamples,writes,bytes:+metadata.format.size,checks},null,2)+'\n');
  console.log(JSON.stringify({duration:report.result.duration,elapsedMs:report.elapsedMs,writes,bytes:metadata.format.size,heapSamples,checks},null,2));
}finally{clearInterval(timer);await sampling;if(!closed)await handle.close().catch(()=>{});await browser.close();}
