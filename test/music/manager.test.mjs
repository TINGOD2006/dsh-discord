import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MusicManager } from '../../src/channels/discord/music.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,1));
async function until(fn){for(let n=0;n<200;n++){if(fn())return;await tick();}throw new Error('state did not settle');}
function fixture({prepare,ready,login,loginTimeoutMs=20000,idleMs=10000}={}) {
  const played=[],connections=[],notices=[],released=[];
  const guild={id:'guild',voiceStates:{cache:new Map([['user',{channelId:'voice'}],['other',{channelId:'elsewhere'}]])},voiceAdapterCreator:{},channels:{cache:new Map()}};
  class Client extends EventEmitter {channels={cache:new Map([['text',{guild}]])};user={id:'bot'};async login(){return login?.();}isReady(){return true;}destroy(){}}
  class Player extends EventEmitter {state={status:'idle'};play(resource){const old=this.state;this.state={status:'playing',resource};played.push(resource);this.emit('stateChange',old,this.state);}stop(){const old=this.state;this.state={status:'idle'};this.emit('stateChange',old,this.state);}pause(){return true;}unpause(){return true;}}
  const runtime={Client,GatewayIntentBits:{Guilds:1,GuildVoiceStates:128},StreamType:{OggOpus:'ogg'},AudioPlayerStatus:{Idle:'idle'},VoiceConnectionStatus:{Ready:'ready',Destroyed:'destroyed',Disconnected:'disconnected',Signalling:'signalling',Connecting:'connecting'},NoSubscriberBehavior:{Pause:'pause'},
    entersState:async(connection)=>{if(ready)await ready();return connection;},
    joinVoiceChannel:()=>{const connection=new EventEmitter();Object.assign(connection,{state:{status:'ready'},subscribe(player){this.subscribed=player;},destroy(){this.state.status='destroyed';},rejoin(){return true;}});connections.push(connection);return connection;},
    createAudioPlayer:()=>new Player(),createAudioResource:(input,options)=>({input,...options,volume:{setVolume(value){this.value=value;}}}),
  };
  const pipeline={prepare:prepare??(async(query)=>({input:'normalized-'+query+'.ogg',title:query,url:'https://www.youtube.com/watch?v=jNQXAC9IVRw',release:()=>released.push(query)})),destroy:async()=>{}};
  const manager=new MusicManager({token:'fixture-only',runtime,pipeline,cooldownMs:0,idleMs,loginTimeoutMs,notify:async(...args)=>notices.push(args)});
  const request={channelId:'text',senderId:'user'};
  return {manager,request,played,connections,notices,released,guild};
}

test('normalization finishes and voice Ready is reached before any playback',async()=>{
  let normalize;const f=fixture({prepare:()=>new Promise(resolve=>{normalize=resolve;})});
  try{await f.manager.play({...f.request,query:'song'});await until(()=>normalize);assert.equal(f.played.length,0);
    normalize({input:'normalized.ogg',title:'song',release(){}});await until(()=>f.played.length===1);
    assert.equal(f.played[0].metadata.lufs,-16);assert.equal(f.played[0].input,'normalized.ogg');assert.equal(f.connections[0].subscribed!=null,true);
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
