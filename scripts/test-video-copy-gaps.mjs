// Real encoded fixture: permitting gaps in the SPS must not itself reject a continuous sequence.
import assert from 'node:assert/strict';
import { openAsBlob } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { openVideoCopy } from '../dist/public.js';
const root=path.resolve('tests/tmp/video-copy-gaps');await mkdir(root,{recursive:true});
const run=(exe,args)=>execFileSync(exe,args,{maxBuffer:16*1024*1024});
const ffmpeg=args=>run(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-nostdin','-y',...args]);
const source=path.join(root,'source.mp4'),allowed=path.join(root,'allowed.mp4'),broken=path.join(root,'discontinuous.mp4');
ffmpeg(['-f','lavfi','-i','testsrc2=size=160x96:rate=25:duration=4','-an','-c:v','libx264','-threads','2','-profile:v','baseline','-bf','0','-g','25','-x264-params','scenecut=0',source]);
const bytes=Buffer.from(await readFile(source));
// Track bit locations in the original escaped NAL for surgical fixture changes, without resizing MP4 boxes.
function bits(nal){
 const locations=[];for(let i=1;i<nal.length;i++){if(i>=3&&nal[i]===3&&nal[i-1]===0&&nal[i-2]===0)continue;for(let b=7;b>=0;b--)locations.push([i,b]);}
 let at=0;return {read(n=1){let x=0;while(n--){const [i,b]=locations[at++];x=x*2+((nal[i]>>b)&1);}return x;},ue(){let n=0;while(!this.read())n++;return 2**n-1+this.read(n);},get at(){return at;},set(position,n,value){for(let j=0;j<n;j++){const [i,b]=locations[position+j];nal[i]=(nal[i]&~(1<<b))|(((value>>(n-1-j))&1)<<b);}}};
}
const avcc=bytes.indexOf('avcC');assert.ok(avcc>0);
const size=bytes.readUInt16BE(avcc+10),sps=bytes.subarray(avcc+12,avcc+12+size),s=bits(sps);
assert.equal(s.read(8),66);s.read(16);s.ue();const frameBits=s.ue()+4,poc=s.ue();
if(poc===0)s.ue();else assert.equal(poc,2);
s.ue();const flag=s.at;assert.equal(s.read(),0);s.set(flag,1,1);await writeFile(allowed,bytes);
const frames=file=>ffmpeg(['-i',file,'-an','-f','framemd5','-']).toString().split('\n').filter(x=>x&&!x.startsWith('#')).map(x=>x.split(',').at(-1).trim());
assert.deepEqual(frames(allowed),frames(source));
const packets=JSON.parse(run(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-select_streams','v:0','-show_packets','-show_data_hash','sha256','-of','json',allowed]).toString()).packets;
const session=await openVideoCopy(await openAsBlob(allowed));
let copied;
try {
 const info=await session.inspect();assert.equal(info.videoPackets,100);
 const plan=await session.plan({keepRanges:[{start:0,end:1},{start:2,end:4}],snap:'strict'});
 const result=await session.exportMp4({plan});copied=path.join(root,'copied.mp4');await writeFile(copied,Buffer.from(await result.blob.arrayBuffer()));assert.equal(result.videoPackets,75);
 assert.deepEqual(frames(copied),[...frames(allowed).slice(0,25),...frames(allowed).slice(50)]);
}finally{await session.close();}
const first=packets.find(p=>!p.flags.includes('K'));let at=+first.pos;const end=at+(+first.size);
let changed=false;
while(at<end){const n=bytes.readUInt32BE(at);at+=4;const nal=bytes.subarray(at,at+n);at+=n;if((nal[0]&31)!==1)continue;
 const b=bits(nal);b.ue();b.ue();b.ue();const position=b.at,frame=b.read(frameBits);b.set(position,frameBits,(frame+2)%(2**frameBits));changed=true;break;}
assert.ok(changed);await writeFile(broken,bytes);
const invalid=await openVideoCopy(await openAsBlob(broken));
try{await assert.rejects(()=>invalid.inspect(),e=>e.reason==='GOP_STRUCTURE'&&/Frame number discontinuity/.test(e.message));}finally{await invalid.close();}
console.log('Passed: SPS gap allowance, retained decoded frames, actual frame-number discontinuity rejection.');
