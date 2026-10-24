import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createMusicEncoder, playbackEncoderArgs, MUSIC_PLAYBACK_PROFILE } from '../../src/channels/discord/music-encoder.mjs';
import { musicTools, MusicAudioPipeline } from '../../src/channels/discord/music-audio.mjs';
import { runMusicProcess } from '../../src/channels/discord/music-process.mjs';

test('playback defaults to 128 kbps stereo and accepts higher rates with fixed 20 ms frames',()=>{
  assert.deepEqual(MUSIC_PLAYBACK_PROFILE,{bitrate:128000,channels:2,sampleRate:48000,frameMs:20});
  const args=playbackEncoderArgs('fixture.ogg',{volume:0.35,bitrate:128000,offsetSeconds:12.34});
  const value=flag=>args[args.indexOf(flag)+1];
  assert.equal(value('-b:a'),'128000');assert.equal(value('-ac'),'2');assert.equal(value('-vbr'),'off');
  assert.equal(value('-compression_level'),'0');assert.equal(value('-frame_duration'),'20');
  assert.equal(value('-ss'),'12.340');assert.equal(value('-af'),'volume=0.350000');assert.equal(args.at(-1),'pipe:1');
  assert.throws(()=>playbackEncoderArgs('fixture',{volume:NaN}),/無效/);
  assert.throws(()=>playbackEncoderArgs('fixture',{channels:6}),/聲道數/);
});

test('lossless cache and real 320/384 kbps Opus preserve separate stereo channels',async t=>{
  const root=resolve('work/test-music');await mkdir(root,{recursive:true});const dir=await mkdtemp(join(root,'stereo-'));
  const tools=musicTools(),input=join(dir,'stereo.wav');
  const pipeline=new MusicAudioPipeline({cacheDir:join(dir,'cache'),tools});
  let source;
  try{
    await runMusicProcess(tools.ffmpeg,['-nostdin','-y','-hide_banner','-loglevel','error','-f','lavfi','-i',
      'aevalsrc=0.1*sin(2*PI*440*t)|0.1*sin(2*PI*880*t):s=48000:d=2','-c:a','pcm_s24le',input],{cwd:dir});
    source=await pipeline.prepare(input);assert(source.input.endsWith('audio.flac'));
    const probe=await runMusicProcess(tools.ffprobe,['-v','error','-show_entries','stream=codec_name,channels,sample_rate,bits_per_raw_sample','-of','json',source.input],{cwd:dir});
    const cached=JSON.parse(probe.stdout).streams[0];assert.equal(cached.codec_name,'flac');assert.equal(cached.channels,2);
    assert.equal(cached.sample_rate,'48000');assert.equal(cached.bits_per_raw_sample,'24');
    for(const kbps of [320,384]){
      const encoder=createMusicEncoder(source.input,{channels:2,bitrate:kbps*1000,volume:0.6});const chunks=[];
      try{for await(const chunk of encoder.stream)chunks.push(chunk);}finally{encoder.destroy();}
      const output=join(dir,`${kbps}.ogg`);await writeFile(output,Buffer.concat(chunks));
      const {stdout}=await runMusicProcess(tools.ffprobe,['-v','error','-show_entries','packet=size:stream=codec_name,channels,sample_rate','-of','json',output],{cwd:dir});
      const info=JSON.parse(stdout);assert.equal(info.streams[0].codec_name,'opus');assert.equal(info.streams[0].channels,2);
      assert(info.packets.length>=100);assert(info.packets.every(x=>Number(x.size)===kbps*2.5));
      const pcm=join(dir,`${kbps}.pcm`);
      await runMusicProcess(tools.ffmpeg,['-nostdin','-y','-hide_banner','-loglevel','error','-i',output,'-ss','0.25','-t','1','-f','f32le',pcm],{cwd:dir});
      const bytes=await readFile(pcm);const frames=bytes.length/8;
      const power=(channel,hz)=>{let re=0,im=0;for(let n=0;n<frames;n++){const sample=bytes.readFloatLE(n*8+channel*4),phase=2*Math.PI*hz*n/48000;re+=sample*Math.cos(phase);im+=sample*Math.sin(phase);}return re*re+im*im;};
      assert(power(0,440)>10*power(0,880),'left must preserve its 440 Hz signal');
      assert(power(1,880)>10*power(1,440),'right must preserve its 880 Hz signal');
      t.diagnostic(`${kbps} kbps: stereo Opus, ${kbps*2.5} bytes/frame; separate L/R verified through FLAC cache`);
    }
  }finally{source?.release();await pipeline.destroy();assert(resolve(dir).startsWith(root+sep));await rm(dir,{recursive:true,force:true});}
});

test('real FFmpeg produces the selected CBR payload sizes from 16 through 256 kbps',async()=>{
  const root=resolve('work/test-music');await mkdir(root,{recursive:true});const dir=await mkdtemp(join(root,'bitrate-'));
  const tools=musicTools(),input=join(dir,'source.wav');
  try{
    await runMusicProcess(tools.ffmpeg,['-nostdin','-y','-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=1',input],{cwd:dir});
    for(const kbps of [16,32,48,64,96,128,192,256]){
      const encoder=createMusicEncoder(input,{bitrate:kbps*1000,channels:1});const chunks=[];
      try{for await(const chunk of encoder.stream)chunks.push(chunk);}finally{encoder.destroy();}
      const output=join(dir,`${kbps}.ogg`);await writeFile(output,Buffer.concat(chunks));
      const {stdout}=await runMusicProcess(tools.ffprobe,['-v','error','-show_entries','packet=size:stream=channels','-of','json',output],{cwd:dir});
      const info=JSON.parse(stdout);assert.equal(info.streams[0].channels,1);assert(info.packets.length>=50);
      assert(info.packets.every(packet=>Number(packet.size)===kbps*2.5),`${kbps} kbps must reach the encoder unchanged`);
    }
  }finally{assert(resolve(dir).startsWith(root+sep));await rm(dir,{recursive:true,force:true});}
});

test('encoder cancellation kills its child exactly once and handles late child errors',async()=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let kills=0;
  child.kill=()=>{kills++;queueMicrotask(()=>child.emit('close',null));return true;};
  const controller=new AbortController();
  const encoder=createMusicEncoder('fixture',{signal:controller.signal,spawnProcess:(file,args,options)=>{
    assert.equal(options.windowsHide,true);assert.deepEqual(options.stdio,['ignore','pipe','pipe']);return child;
  }});
  controller.abort();encoder.destroy();child.emit('error',new Error('private diagnostic'));
  await Promise.resolve();assert.equal(kills,1);assert.equal(encoder.stream.destroyed,true);
});

test('an unavailable encoder fails cleanly without exposing the executable path',async()=>{
  const encoder=createMusicEncoder('fixture',{ffmpeg:resolve('work/nonexistent-private-encoder.exe')});
  try{await assert.rejects(async()=>{for await(const chunk of encoder.stream)void chunk;},error=>{
    assert.match(error.message,/無法啟動 FFmpeg/);assert(!error.message.includes('nonexistent-private'));return true;
  });}finally{encoder.destroy();}
});

test('real FFmpeg output is stereo CBR Opus at the default rate, honors seek position and applies the requested volume once',async()=>{
  const root=resolve('work/test-music');await mkdir(root,{recursive:true});const dir=await mkdtemp(join(root,'encoder-'));
  const tools=musicTools(),input=join(dir,'source.wav');
  try{
    await runMusicProcess(tools.ffmpeg,['-nostdin','-y','-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=2','-ac','2',input],{cwd:dir});
    const levels=[];
    for(const volume of [0.6,0.3]){
      const encoder=createMusicEncoder(input,{volume,offsetSeconds:0.5});const chunks=[];
      try{for await(const chunk of encoder.stream)chunks.push(chunk);}finally{encoder.destroy();}
      const output=join(dir,`volume-${volume}.ogg`);await writeFile(output,Buffer.concat(chunks));
      const probe=await runMusicProcess(tools.ffprobe,['-v','error','-show_entries','stream=channels,sample_rate:format=duration:packet=size','-of','json',output],{cwd:dir});
      const info=JSON.parse(probe.stdout);assert.equal(info.streams[0].channels,2);assert.equal(info.streams[0].sample_rate,'48000');
      assert(Math.abs(Number(info.format.duration)-1.5)<0.08);assert(info.packets.length>=75);
      assert(info.packets.every(packet=>Number(packet.size)===320),'128 kbps stereo at 20 ms must use 320-byte audio packets');
      const measured=await runMusicProcess(tools.ffmpeg,['-nostdin','-hide_banner','-i',output,'-af','volumedetect','-f','null','-'],{cwd:dir});
      levels.push(Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(measured.stderr)?.[1]));
    }
    assert(Math.abs(levels[1]-levels[0]+6.02)<0.5,'halving gain should reduce loudness by about 6 dB');
  }finally{assert(resolve(dir).startsWith(root+sep));await rm(dir,{recursive:true,force:true});}
});
