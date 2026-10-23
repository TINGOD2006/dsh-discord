import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MusicManager, MUSIC_DEFAULT_VOLUME } from '../../src/channels/discord/music.mjs';
import { DiscordHarnessBridge } from '../../src/channels/discord/discord-bridge.mjs';
import { handleApplicationCommand } from '../../src/channels/discord/discord-commands.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,1));
async function until(fn){for(let n=0;n<200;n++){if(fn())return;await tick();}throw new Error('state did not settle');}
function fixture({prepare,ready,login,loginTimeoutMs=20000,idleMs=10000,recoverVoice}={}) {
  const played=[],connections=[],notices=[],released=[];
  const guild={id:'guild',voiceStates:{cache:new Map([['user',{channelId:'voice'}],['other',{channelId:'elsewhere'}]])},voiceAdapterCreator:{},channels:{cache:new Map()}};
  class Client extends EventEmitter {channels={cache:new Map([['text',{guild}],['text-two',{guild}]])};user={id:'bot'};async login(){return login?.();}isReady(){return true;}destroy(){}}
  class Player extends EventEmitter {state={status:'idle'};play(resource){const old=this.state;this.state={status:'playing',resource};played.push(resource);this.emit('stateChange',old,this.state);}stop(){const old=this.state;this.state={status:'idle'};this.emit('stateChange',old,this.state);}pause(){this.paused=true;return true;}unpause(){this.paused=false;return true;}}
  const runtime={Client,GatewayIntentBits:{Guilds:1,GuildVoiceStates:128},StreamType:{OggOpus:'ogg'},AudioPlayerStatus:{Idle:'idle'},VoiceConnectionStatus:{Ready:'ready',Destroyed:'destroyed',Disconnected:'disconnected',Signalling:'signalling',Connecting:'connecting'},NoSubscriberBehavior:{Pause:'pause'},
    entersState:async(connection)=>{if(ready)await ready();return connection;},
    joinVoiceChannel:()=>{const connection=new EventEmitter();Object.assign(connection,{state:{status:'ready'},subscribe(player){this.subscribed=player;},destroy(){this.state.status='destroyed';},rejoin(){return true;}});connections.push(connection);return connection;},
    createAudioPlayer:()=>new Player(),createAudioResource:(input,options)=>({input,...options,encoder:{setBitrate(value){this.bitrate=value;}},volume:{setVolume(value){this.value=value;}}}),
  };
  const pipeline={prepare:prepare??(async(query)=>({input:'normalized-'+query+'.ogg',title:query,url:'https://www.youtube.com/watch?v=jNQXAC9IVRw',release:()=>released.push(query)})),destroy:async()=>{}};
  const bufferedFactory=async(libs,input,options)=>{const resource=libs.createAudioResource(input,{metadata:options.metadata});resource.encoder.setBitrate(options.bitrate);resource.volume.setVolume(options.volume);return{resource,destroy(){},resetTiming(){},snapshot:()=>({framesRead:1,sourceStarved:0,maxReadGapMs:20,bufferedMs:400,bitrate:options.bitrate})}};
  const manager=new MusicManager({bufferedFactory,...(recoverVoice?{recoverVoice}:{}),token:'fixture-only',runtime,pipeline,cooldownMs:0,idleMs,loginTimeoutMs,notify:async(...args)=>notices.push(args)});
  const request={channelId:'text',senderId:'user'};
  return {manager,request,played,connections,notices,released,guild};
}

test('normalization finishes and voice Ready is reached before any playback',async()=>{
  let normalize;const f=fixture({prepare:()=>new Promise(resolve=>{normalize=resolve;})});
  try{await f.manager.play({...f.request,query:'song'});await until(()=>normalize);assert.equal(f.played.length,0);
    normalize({input:'normalized.ogg',title:'song',release(){}});await until(()=>f.played.length===1);
    assert.equal(f.played[0].metadata.lufs,-20);assert.equal(f.played[0].input,'normalized.ogg');assert.equal(f.connections[0].subscribed!=null,true);
    assert.equal(f.played[0].volume.value,MUSIC_DEFAULT_VOLUME);assert.equal(MUSIC_DEFAULT_VOLUME,0.6);
    assert.equal(f.played[0].encoder.bitrate,128000);
  }finally{await f.manager.destroy();}
});

test('stop during preparation cancels current and prefetched songs, without resurrection',async()=>{
  const pending=[];const f=fixture({prepare:(query,options)=>new Promise(resolve=>pending.push({query,options,resolve}))});
  try{await f.manager.play({...f.request,query:'first'});await f.manager.play({...f.request,query:'second'});await until(()=>pending.length===2);
    await f.manager.stop(f.request);assert(pending.every(item=>item.options.signal.aborted));
    for(const item of pending)item.resolve({input:'late.ogg',title:item.query,release(){}});
    await tick();await tick();assert.equal(f.played.length,0);assert.match((await f.manager.queue(f.request)).message,/空/);
  }finally{await f.manager.destroy();}
});

test('skip during download advances exactly once and ignores the cancelled result',async()=>{
  const pending=[];const f=fixture({prepare:(query,options)=>new Promise(resolve=>pending.push({query,options,resolve}))});
  try{await f.manager.play({...f.request,query:'first'});await f.manager.play({...f.request,query:'second'});await until(()=>pending.length===2);
    await f.manager.next(f.request);pending[0].resolve({input:'first.ogg',title:'first',release(){}});pending[1].resolve({input:'second.ogg',title:'second',release(){}});
    await until(()=>f.played.length===1);assert.equal(f.played[0].metadata.title,'second');assert.equal(pending[0].options.signal.aborted,true);
  }finally{await f.manager.destroy();}
});

test('pause, resume and volume affect music; other voice channels cannot control it',async()=>{
  const f=fixture();try{await f.manager.play({...f.request,query:'song'});await until(()=>f.played.length===1);
    await f.manager.pause(f.request);assert.match((await f.manager.queue(f.request)).message,/已暫停/);
    await f.manager.resume(f.request);await f.manager.volume({...f.request,percent:35});assert.equal(f.played[0].volume.value,0.35);
    await assert.rejects(f.manager.stop({...f.request,senderId:'other'}),/目前所在/);
    assert.match((await f.manager.nowplaying(f.request)).message,/song/);
  }finally{await f.manager.destroy();}
});

test('idle disconnects and leave releases cached media',async()=>{
  const f=fixture({idleMs:15});await f.manager.join(f.request);await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.connections[0].state.status,'destroyed');
  await f.manager.play({...f.request,query:'song'});await until(()=>f.played.length===1);await f.manager.leave(f.request);assert.deepEqual(f.released,['song']);await f.manager.destroy();
});

test('voice Ready failure destroys the connection before downloading any audio',async()=>{
  let prepared=0;const f=fixture({ready:async()=>{throw new Error('not ready');},prepare:async()=>{prepared++;}});
  try{await assert.rejects(f.manager.play({...f.request,query:'song'}),/語音連線/);assert.equal(prepared,0);assert.equal(f.connections[0].state.status,'destroyed');}
  finally{await f.manager.destroy();}
});

test('Idle advances once and a late error from the old track cannot stop the next track',async()=>{
  const f=fixture();try{
    await f.manager.play({...f.request,query:'first'});await f.manager.play({...f.request,query:'second'});await until(()=>f.played.length===1);
    const first=f.played[0],player=f.connections[0].subscribed;player.stop();await until(()=>f.played.length===2);
    player.emit('error',{resource:first,message:'old track error'});await tick();assert.equal(f.played.length,2);
    assert.match((await f.manager.nowplaying(f.request)).message,/second/);
  }finally{await f.manager.destroy();}
});

test('a stalled Discord login cannot leave a music command thinking forever',async()=>{
  const f=fixture({login:()=>new Promise(()=>{}),loginTimeoutMs:20});const started=Date.now();
  try{await assert.rejects(f.manager.play({...f.request,query:'song'}),/連線逾時/);assert(Date.now()-started<1000);assert.equal(f.played.length,0);}
  finally{await f.manager.destroy();}
});

test('transport reconnect pauses and resumes the same track without clearing its queue',async()=>{
  let finish;const f=fixture({recoverVoice:()=>new Promise(resolve=>{finish=resolve;})});
  try{
    await f.manager.play({...f.request,query:'first'});await f.manager.play({...f.request,query:'second'});await until(()=>f.played.length===1);
    const player=f.connections[0].subscribed,resource=f.played[0];
    f.connections[0].emit('disconnected');await until(()=>finish);assert.equal(player.paused,true);
    finish({attempts:1});await until(()=>player.paused===false);
    assert.equal(f.played.length,1);assert.equal(f.played[0],resource);assert.match((await f.manager.queue(f.request)).message,/second/);
  }finally{await f.manager.destroy();}
});

test('voice channel bandwidth caps the music encoder bitrate',async()=>{
  const f=fixture();f.guild.channels.cache.set('voice',{bitrate:64000});
  try{await f.manager.play({...f.request,query:'song'});await until(()=>f.played.length===1);assert.equal(f.played[0].encoder.bitrate,64000);}
  finally{await f.manager.destroy();}
});

test('cross-channel commands share one guild lane and create only one voice connection',async()=>{
  let release,entered=0;const f=fixture({ready:async()=>{if(++entered===1)await new Promise(resolve=>{release=resolve;});}});
  try{
    const first=f.manager.execute('play',{...f.request,guildId:'guild',query:'first'});
    await until(()=>release);
    const second=f.manager.execute('play',{...f.request,channelId:'text-two',guildId:'guild',query:'second'});
    await tick();assert.equal(f.connections.length,1);assert.equal(entered,1);
    release();await Promise.all([first,second]);await until(()=>f.played.length===1);
    assert.equal(f.connections.length,1);assert.match((await f.manager.queue(f.request)).message,/first[\s\S]*second/);
  }finally{release?.();await f.manager.destroy();}
});

test('stop interrupts a stalled connection and a later play cannot be overwritten by its late result',async()=>{
  let release,entered=0;const f=fixture({ready:async()=>{if(++entered===1)await new Promise(resolve=>{release=resolve;});}});
  try{
    const first=f.manager.execute('play',{...f.request,guildId:'guild',query:'old'});
    const cancelled=assert.rejects(first,{name:'AbortError'});await until(()=>release);
    await f.manager.execute('stop',{...f.request,guildId:'guild'});await cancelled;
    assert.equal(f.connections[0].state.status,'destroyed');assert.equal(f.played.length,0);
    await f.manager.execute('play',{...f.request,guildId:'guild',query:'new'});await until(()=>f.played.length===1);
    release();await tick();assert.equal(f.played[0].metadata.title,'new');assert.equal(f.played.length,1);
  }finally{release?.();await f.manager.destroy();}
});

test('unauthorized stop cannot cancel an in-flight admission from a different voice channel',async()=>{
  let release,entered=0;const f=fixture({ready:async()=>{if(++entered===1)await new Promise(resolve=>{release=resolve;});}});
  try{
    const first=f.manager.execute('play',{...f.request,guildId:'guild',query:'song'});await until(()=>release);
    await assert.rejects(f.manager.execute('stop',{...f.request,guildId:'guild',senderId:'other'}),/目前所在/);
    release();await first;await until(()=>f.played.length===1);assert.equal(f.played[0].metadata.title,'song');
  }finally{release?.();await f.manager.destroy();}
});

test('skip advances even when the cancelled preparer ignores abort and releases its late result',async()=>{
  let late;const released=[];
  const f=fixture({prepare:async query=>query==='old'?new Promise(resolve=>{late=resolve;}):{input:'new.ogg',title:query,release(){}}});
  try{
    await f.manager.play({...f.request,query:'old'});await f.manager.play({...f.request,query:'new'});await until(()=>late);
    await f.manager.next(f.request);await until(()=>f.played.length===1);assert.equal(f.played[0].metadata.title,'new');
    late({input:'old.ogg',title:'old',release:()=>released.push('old')});await until(()=>released.length===1);
    assert.equal(f.played.length,1);
  }finally{await f.manager.destroy();}
});

test('shutdown during connection cancels both active and queued admissions without late playback',async()=>{
  let release;const f=fixture({ready:()=>new Promise(resolve=>{release=resolve;})});
  const first=f.manager.execute('play',{...f.request,guildId:'guild',query:'first'});
  const cancelled=assert.rejects(first,{name:'AbortError'});await until(()=>release);
  const second=f.manager.execute('play',{...f.request,guildId:'guild',query:'second'});
  const alsoCancelled=assert.rejects(second,{name:'AbortError'});
  await f.manager.destroy();await Promise.all([cancelled,alsoCancelled]);release();await tick();assert.equal(f.played.length,0);
});

test('an idle voice connection is still protected from controls in another voice channel',async()=>{
  const f=fixture();try{await f.manager.join(f.request);await assert.rejects(f.manager.leave({...f.request,senderId:'other'}),/目前所在/);}
  finally{await f.manager.destroy();}
});

test('delayed acknowledgement cannot make an older native play run after a newer stop',async()=>{
  const f=fixture(),lifetime=new AbortController(),replies=[];let releaseAck;
  const bridge=new DiscordHarnessBridge({signal:lifetime.signal,bot:{sendText:async()=>{}},harness:{},state:{sessionFor:()=>null},
    musicTools:{execute:(verb,args)=>f.manager.execute(verb,args)}});
  const invoke=(id,data)=>handleApplicationCommand({type:2,id,token:id,channel_id:'text',guild_id:'guild',user:{id:'user'},data},{
    bridge,applicationId:'app',api:{createInteractionResponse:async actual=>{if(actual==='old')await new Promise(resolve=>{releaseAck=resolve;});},
      updateInteractionOriginal:async(app,id,body)=>{replies.push({id,text:body.content});}},
  });
  try{
    const old=invoke('old',{name:'play',options:[{type:3,name:'query',value:'old-song'}]});await until(()=>releaseAck);
    await invoke('stop',{name:'music',options:[{type:1,name:'stop'}]});
    releaseAck();await old;assert.equal(f.played.length,0);assert.match(replies.find(reply=>reply.id==='old').text,/取消/);
    await invoke('new',{name:'play',options:[{type:3,name:'query',value:'new-song'}]});await until(()=>f.played.length===1);
    assert.equal(f.played[0].metadata.title,'new-song');
  }finally{releaseAck?.();lifetime.abort();await f.manager.destroy();}
});

test('a failed native acknowledgement releases its reservation without playback or blocking the next command',async()=>{
  const f=fixture(),lifetime=new AbortController();
  const bridge=new DiscordHarnessBridge({signal:lifetime.signal,bot:{sendText:async()=>{}},harness:{},state:{sessionFor:()=>null},
    musicTools:{execute:(verb,args)=>f.manager.execute(verb,args)}});
  const invoke=(id)=>handleApplicationCommand({type:2,id,token:'fixture',channel_id:'text',guild_id:'guild',user:{id:'user'},
    data:{name:'play',options:[{type:3,name:'query',value:id}]}},{bridge,applicationId:'app',
    api:{createInteractionResponse:async()=>{if(id==='failed')throw new Error('fixture acknowledgement failure');},updateInteractionOriginal:async()=>{}},
  });
  try{
    assert.equal(await invoke('failed'),false);assert.equal(f.played.length,0);
    await invoke('next');await until(()=>f.played.length===1);assert.equal(f.played[0].metadata.title,'next');
  }finally{lifetime.abort();await f.manager.destroy();}
});

test('slow text-message persistence cannot revive an older play after a native stop',async()=>{
  const f=fixture(),lifetime=new AbortController(),replies=[];let record;
  const bridge=new DiscordHarnessBridge({signal:lifetime.signal,bot:{sendText:async(target,text)=>replies.push(text)},harness:{},
    state:{hasSeen:()=>false,markSeen:()=>new Promise(resolve=>{record=resolve;}),sessionFor:()=>null},
    musicTools:{execute:(verb,args)=>f.manager.execute(verb,args)}});
  try{
    const old=bridge.accept({messageId:'old',conversationId:'text',guildId:'guild',kind:'group',senderId:'user',addressed:true,
      content:'/play old-song',replyTarget:{channelId:'text'},images:[],files:[]});await until(()=>record);
    await bridge.runNativeCommand('/music stop',{conversationId:'text',guildId:'guild',senderId:'user'});
    record();await old;assert.equal(f.played.length,0);assert.match(replies[0],/取消/);
  }finally{record?.();lifetime.abort();await f.manager.destroy();}
});
