import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { MusicAudioPipeline, musicTools, loudnessStats, youtubeUrl, completeDuration } from '../../src/channels/discord/music-audio.mjs';
import { runMusicProcess } from '../../src/channels/discord/music-process.mjs';

const work=resolve('work/test-music');
async function scratch(fn){await mkdir(work,{recursive:true});const dir=await mkdtemp(join(work,'case-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}

test('only real YouTube host and video shapes reach the direct route',()=>{
  assert.equal(youtubeUrl('https://youtu.be/jNQXAC9IVRw'),'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  for(const url of ['https://youtube.com.evil.invalid/watch?v=jNQXAC9IVRw','file://youtube.com/watch?v=jNQXAC9IVRw','https://u:p@youtube.com/watch?v=jNQXAC9IVRw','https://youtube.com/playlist?list=123'])assert.equal(youtubeUrl(url),null);
  assert.equal(completeDuration(696,10),false);assert.equal(completeDuration(19,19.01),true);
});

test('quiet and loud recordings are normalized before use and repeated playback uses the cache',async()=>{
  await scratch(async dir=>{
    const tools=musicTools();const pipeline=new MusicAudioPipeline({cacheDir:join(dir,'cache'),tools});
    const levels=[];
    try{for(const [name,gain] of [['quiet',0.04],['loud',4]]){
      const input=join(dir,name+'.wav');
      await runMusicProcess(tools.ffmpeg,['-y','-f','lavfi','-i','sine=frequency=440:duration=5','-af','volume='+gain,'-ar','48000',input],{cwd:dir});
      const source=await pipeline.prepare(input);assert.equal(source.loudness.integrated,-16);assert(source.input.startsWith(dir));
      const measured=await runMusicProcess(tools.ffmpeg,['-hide_banner','-i',source.input,'-af','loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json','-f','null','-'],{cwd:dir});
      const stats=loudnessStats(measured.stderr);levels.push(Number(stats.input_i));assert(Math.abs(Number(stats.input_i)+16)<0.5);source.release();
      const cached=await pipeline.prepare(input);assert.equal(cached.cacheHit,true);cached.release();
    }assert(Math.abs(levels[0]-levels[1])<0.3);}finally{await pipeline.destroy();}
  });
});

test('cancelling one shared request does not cancel another guild consumer',async()=>{
  await scratch(async dir=>{
    const input=join(dir,'fixture.wav');await writeFile(input,Buffer.alloc(4096));let begin;const gate=new Promise(resolve=>{begin=resolve;});let probeCalls=0;
    const run=async(file,args,{signal})=>{
      if(file==='probe'){probeCalls++;await gate;assert.equal(signal.aborted,false);return {stdout:JSON.stringify({streams:[{codec_type:'audio'}],format:{duration:5}}),stderr:''};}
      if(args.includes('null'))return {stdout:'',stderr:'{"input_i":"-20","input_tp":"-10","input_lra":"0","input_thresh":"-30","target_offset":"0"}'};
      await writeFile(args.at(-1),Buffer.alloc(4096));return {stdout:'',stderr:''};
    };
    const pipeline=new MusicAudioPipeline({cacheDir:join(dir,'cache'),tools:{ffmpeg:'ffmpeg',ffprobe:'probe'},run});
    try{
      const controller=new AbortController();const first=pipeline.prepare(input,{signal:controller.signal,guildId:'one'});first.catch(()=>{});
      const second=pipeline.prepare(input,{guildId:'two'});
      while(!probeCalls)await new Promise(resolve=>setTimeout(resolve,1));
      controller.abort();begin();await assert.rejects(first,{name:'AbortError'});const result=await second;assert(result.input.endsWith('audio.ogg'));result.release();
    }finally{await pipeline.destroy();}
  });
});

test('subprocess deadline and cancellation settle promptly and preserve UTF-8 output',async()=>{
  await scratch(async dir=>{
    const result=await runMusicProcess(process.execPath,['-e',"process.stdout.write('初音ミク')"],{cwd:dir});assert.equal(result.stdout,'初音ミク');
    const started=Date.now();await assert.rejects(runMusicProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:dir,timeoutMs:50}),/逾時/);assert(Date.now()-started<5000);
    const controller=new AbortController();const pending=runMusicProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:dir,signal:controller.signal});
    const cancelledAt=Date.now();controller.abort();assert(Date.now()-cancelledAt<250,'cancellation must not block Discord heartbeats');
    await assert.rejects(pending,{name:'AbortError'});
  });
});
