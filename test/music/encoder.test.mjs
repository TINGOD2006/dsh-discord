import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createMusicEncoder, playbackEncoderArgs, MUSIC_PLAYBACK_PROFILE } from '../../src/channels/discord/music-encoder.mjs';
import { musicTools } from '../../src/channels/discord/music-audio.mjs';
import { runMusicProcess } from '../../src/channels/discord/music-process.mjs';

test('playback profile uses low-complexity 32 kbps mono, fixed 20 ms frames and a seekable constant gain',()=>{
  assert.deepEqual(MUSIC_PLAYBACK_PROFILE,{bitrate:32000,channels:1,sampleRate:48000,frameMs:20});
  const args=playbackEncoderArgs('fixture.ogg',{volume:0.35,bitrate:128000,offsetSeconds:12.34});
  const value=flag=>args[args.indexOf(flag)+1];
  assert.equal(value('-b:a'),'32000');assert.equal(value('-ac'),'1');assert.equal(value('-vbr'),'off');
  assert.equal(value('-compression_level'),'0');assert.equal(value('-frame_duration'),'20');
  assert.equal(value('-ss'),'12.340');assert.equal(value('-af'),'volume=0.350000');assert.equal(args.at(-1),'pipe:1');
  assert.throws(()=>playbackEncoderArgs('fixture',{volume:NaN}),/無效/);
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

test('real FFmpeg output is mono CBR Opus, honors seek position and applies the requested volume once',async()=>{
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
      const info=JSON.parse(probe.stdout);assert.equal(info.streams[0].channels,1);assert.equal(info.streams[0].sample_rate,'48000');
      assert(Math.abs(Number(info.format.duration)-1.5)<0.08);assert(info.packets.length>=75);
      assert(info.packets.every(packet=>Number(packet.size)===80),'32 kbps at 20 ms must use 80-byte audio packets');
      const measured=await runMusicProcess(tools.ffmpeg,['-nostdin','-hide_banner','-i',output,'-af','volumedetect','-f','null','-'],{cwd:dir});
      levels.push(Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(measured.stderr)?.[1]));
    }
    assert(Math.abs(levels[1]-levels[0]+6.02)<0.5,'halving gain should reduce loudness by about 6 dB');
  }finally{assert(resolve(dir).startsWith(root+sep));await rm(dir,{recursive:true,force:true});}
});
