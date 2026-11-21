import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MusicManager, MUSIC_DEFAULT_VOLUME, describeError } from '../../src/channels/discord/music.mjs';
import { YOUTUBE_CLIENT_FALLBACK } from '../../src/channels/discord/music-audio.mjs';
import { DiscordHarnessBridge } from '../../src/channels/discord/discord-bridge.mjs';
import { handleApplicationCommand } from '../../src/channels/discord/discord-commands.mjs';
import { createMusicRequestContext, createMusicTool, musicAccess } from '../../src/channels/shared/music-access.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,1));
async function until(fn){for(let n=0;n<200;n++){if(fn())return;await tick();}throw new Error('state did not settle');}
function fixture({prepare,ready,login,loginTimeoutMs=20000,idleMs=10000,recoverVoice,nativeTransport=false,customBufferedFactory,deferredPlaying=false,refreshStream,dropAfterReady=false}={}) {
  const played=[],connections=[],notices=[],released=[],transports=[];
  const guild={id:'guild',voiceStates:{cache:new Map([['user',{channelId:'voice'}],['other',{channelId:'elsewhere'}]])},voiceAdapterCreator:{},channels:{cache:new Map()}};
  class Client extends EventEmitter {channels={cache:new Map([['text',{guild}],['text-two',{guild}]])};guilds={cache:new Map([['guild',guild]])};user={id:'bot'};async login(){return login?.();}isReady(){return true;}destroy(){}}
  class Player extends EventEmitter {state={status:'idle'};play(resource){const old=this.state;this.paused=false;this.state={status:deferredPlaying?'buffering':'playing',resource};played.push(resource);this.emit('stateChange',old,this.state);if(deferredPlaying)setTimeout(()=>{if(this.state.resource===resource){const old=this.state;this.state={status:'playing',resource};this.emit('stateChange',old,this.state);}},1);}stop(){const old=this.state;this.state={status:'idle'};this.emit('stateChange',old,this.state);}pause(){if(this.state.status==='buffering')return false;this.paused=true;return true;}unpause(){this.paused=false;return true;}}
  const runtime={Client,GatewayIntentBits:{Guilds:1,GuildVoiceStates:128},StreamType:{OggOpus:'ogg'},AudioPlayerStatus:{Idle:'idle',Playing:'playing'},VoiceConnectionStatus:{Ready:'ready',Destroyed:'destroyed',Disconnected:'disconnected',Signalling:'signalling',Connecting:'connecting'},NoSubscriberBehavior:{Pause:'pause'},
    entersState:async(connection)=>{if(ready)await ready();if(dropAfterReady&&connection.state.status==='ready')connection.state.status='signalling';return connection;},
    joinVoiceChannel:()=>{const connection=new EventEmitter();Object.assign(connection,{state:{status:'ready'},subscribe(player){this.subscribed=player;},destroy(){this.state.status='destroyed';},rejoin(){return true;}});connections.push(connection);return connection;},
    createAudioPlayer:()=>new Player(),createAudioResource:(input,options)=>({input,...options,encoder:{setBitrate(value){this.bitrate=value;}},volume:{setVolume(value){this.value=value;}}}),
  };
  const pipeline={prepare:prepare??(async(query)=>({input:'normalized-'+query+'.ogg',title:query,url:'https://www.youtube.com/watch?v=jNQXAC9IVRw',release:()=>released.push(query)})),...(refreshStream?{refreshStream}:{}),destroy:async()=>{}};
  const createTransport=(libs,input,options)=>{const resource=libs.createAudioResource(input,{metadata:options.metadata});resource.encoder.setBitrate(options.bitrate);resource.volume.setVolume(options.volume);if(nativeTransport){delete resource.encoder;delete resource.volume;}const transport={resource,options,offsetSeconds:options.offsetSeconds??0,destroyed:false,destroy(){this.destroyed=true;},resetTiming(){},snapshot:()=>({framesRead:1,sourceStarved:0,maxReadGapMs:20,bufferedMs:400,bitrate:options.bitrate})};transports.push(transport);return transport;};
  const bufferedFactory=customBufferedFactory?((libs,input,options)=>customBufferedFactory(libs,input,options,createTransport)):(async(libs,input,options)=>createTransport(libs,input,options));
  const manager=new MusicManager({bufferedFactory,...(recoverVoice?{recoverVoice}:{}),token:'fixture-only',runtime,pipeline,cooldownMs:0,idleMs,loginTimeoutMs,notify:async(...args)=>notices.push(args)});
  const request={channelId:'text',senderId:'user'};
  return {manager,request,played,connections,notices,released,guild,transports};
}

test('play keeps the chosen method through the queue and reports the effective selector', async () => {
  const selections = [];
  const f = fixture({ prepare: async (query, { selectionMethod }) => {
    selections.push({ query, selectionMethod });
    return { input: 'song.flac', title: 'Chosen song', selection: 'tfidf' };
  } });
  try {
    await f.manager.execute('play', { ...f.request, guildId: 'guild', query: 'song', selectionMethod: 'tfidf' });
    await until(() => f.notices.some(([, message]) => message.includes('選歌方法：TF-IDF＋餘弦相似度')));
    assert.deepEqual(selections, [{ query: 'song', selectionMethod: 'tfidf' }]);
    assert.equal(f.played.length, 1);
  } finally {
    await f.manager.destroy();
  }
});

test('chat music tool reaches the real manager with voice checks and accepted playback outlives the chat grant',async()=>{
  const f=fixture();f.guild.channels.cache.set('voice',{bitrate:128000});
  const invoke=async(senderId)=>{
    const context=createMusicRequestContext({messageId:'request-'+senderId,kind:'group',guildId:'guild',conversationId:'text',senderId,content:'請播放song'},
      {execute:(action,args)=>f.manager.execute(action,args)});
    const session={id:'chat-'+senderId,events:[{type:'turn/start',data:{turn:1}}]},close=musicAccess.open(session.id,'rpc',context);
    musicAccess.observe(session,session.events[0]);musicAccess.claim(session,{source:{rpcId:'rpc'}},1);
    try{return await createMusicTool().execute({action:'play',query:'song',reason:'目前使用者要求播放song'},{agent:{session}});}finally{close();}
  };
  try{
    await invoke('user');await until(()=>f.played.length===1);assert.equal(f.played[0].encoder.bitrate,128000);
    await assert.rejects(invoke('other'),/目前所在/);assert.equal(f.played.length,1);
    assert.match((await f.manager.nowplaying(f.request)).message,/song/);
  }finally{await f.manager.destroy();}
});

test('normalization finishes and voice Ready is reached before any playback',async()=>{
  let normalize;const f=fixture({prepare:()=>new Promise(resolve=>{normalize=resolve;})});
  try{await f.manager.play({...f.request,query:'song'});await until(()=>normalize);assert.equal(f.played.length,0);
    normalize({input:'normalized.ogg',title:'song',release(){}});await until(()=>f.played.length===1);
    assert.equal(f.played[0].metadata.lufs,-20);assert.equal(f.played[0].input,'normalized.ogg');assert.equal(f.connections[0].subscribed!=null,true);
    assert.equal(f.played[0].volume.value,MUSIC_DEFAULT_VOLUME);assert.equal(MUSIC_DEFAULT_VOLUME,0.6);
    assert.equal(f.played[0].encoder.bitrate,192000);
  }finally{await f.manager.destroy();}
});

test('a track past the cache limit streams and says so in the channel',async()=>{
  const f=fixture({prepare:async query=>({stream:true,input:'https://media.example/audio',duration:7200,limitSec:3600,
    title:'long mix',url:'https://www.youtube.com/watch?v=jNQXAC9IVRw',release(){}})});
  try{
    await f.manager.play({...f.request,query:'long mix'});await until(()=>f.played.length===1);
    assert.equal(f.played[0].input,'https://media.example/audio','the media URL is played directly');
    const notice=f.notices.map(args=>args[1]).find(text=>text.includes('正在播放'));
    assert.match(notice,/串流/);assert.match(notice,/2:00:00/);assert.match(notice,/60 分鐘上限/);
    assert.equal(f.manager.snapshot('guild').stream,true);
  }finally{await f.manager.destroy();}
});

test('a pasted share line shows its title instead of the whole link',async()=>{
  const share='【《驯龙少年谣》| BLG 2026全球总决赛应援曲】https://www.bilibili.com/video/BV1mRW46XEdS/?share_source=copy_web&vd_source=995567b3154f75a7331c17710570cb92';
  const f=fixture({prepare:async()=>{throw new Error('找不到可播放的 YouTube 歌曲');}});
  try{
    const {message}=await f.manager.play({...f.request,query:share});
    assert.equal(message,'正在準備歌曲並統一音量：驯龙少年谣 | BLG 2026全球总决赛应援曲');
    await until(()=>f.notices.some(args=>String(args[1]).includes('無法播放')));
    const notice=f.notices.map(args=>args[1]).find(text=>text.includes('無法播放'));
    assert.match(notice,/驯龙少年谣/);
    assert.doesNotMatch(notice,/https:\/\//);
  }finally{await f.manager.destroy();}
});

test('a streamed track gets the deeper network buffer',async()=>{
  let options;
  const f=fixture({customBufferedFactory:(libs,input,opts,createTransport)=>{options=opts;return createTransport(libs,input,opts);},
    prepare:async()=>({stream:true,input:'https://media.example/audio',duration:7200,limitSec:3600,title:'long mix',release(){}})});
  try{
    await f.manager.play({...f.request,query:'long mix'});await until(()=>f.played.length===1);
    assert.equal(options.stream,true);
    assert.equal(options.bufferFrames,250);
    assert.equal(options.prebufferFrames,50);
    assert.equal(options.timeoutMs,15000);
  }finally{await f.manager.destroy();}
});

test('a local file past the limit streams without the network buffer',async()=>{
  let options;
  const f=fixture({customBufferedFactory:(libs,input,opts,createTransport)=>{options=opts;return createTransport(libs,input,opts);},
    prepare:async()=>({stream:true,input:'C:/music/long.flac',duration:7200,limitSec:3600,title:'long file',release(){}})});
  try{
    await f.manager.play({...f.request,query:'long file'});await until(()=>f.played.length===1);
    assert.equal(options.stream,true);
    assert.equal(options.bufferFrames,undefined,'a local file keeps the default cushion');
  }finally{await f.manager.destroy();}
});

test('a streamed track whose first transport fails refreshes its URL and retries once',async()=>{
  const attempts=[];let refreshed=0;
  const f=fixture({
    prepare:async()=>({kind:'bilibili',stream:true,input:'https://media.example/signed-0.m4a',duration:7200,limitSec:3600,
      title:'long mix',url:'https://www.bilibili.com/video/BV1z44y1N7UH',release(){}}),
    refreshStream:async source=>{refreshed++;source.input='https://media.example/signed-1.m4a';return source;},
    customBufferedFactory:(libs,input,opts,createTransport)=>{
      attempts.push(input);
      if(attempts.length===1)throw new Error('FFmpeg 播放編碼失敗 (1)：Server returned 403 Forbidden');
      return createTransport(libs,input,opts);
    }});
  try{
    await f.manager.play({...f.request,query:'long mix'});await until(()=>f.played.length===1);
    assert.deepEqual(attempts,['https://media.example/signed-0.m4a','https://media.example/signed-1.m4a'],'the expired URL is replaced once');
    assert.equal(refreshed,1);
    assert.equal(f.played[0].input,'https://media.example/signed-1.m4a');
  }finally{await f.manager.destroy();}
});

test('a YouTube stream refused with 403 re-resolves with the fallback client',async()=>{
  const clients=[];let attempts=0;
  const f=fixture({
    prepare:async()=>({kind:'youtube',stream:true,input:'https://media.example/signed-0.m4a',duration:7200,limitSec:3600,
      title:'long mix',url:'https://www.youtube.com/watch?v=JPDnHkA1VVA',release(){}}),
    refreshStream:async(source,options)=>{clients.push(options?.client);source.input='https://media.example/signed-1.m4a';return source;},
    customBufferedFactory:(libs,input,opts,createTransport)=>{
      attempts++;
      if(attempts===1)throw new Error('FFmpeg 播放編碼失敗 (1)：Server returned 403 Forbidden');
      return createTransport(libs,input,opts);
    }});
  try{
    await f.manager.play({...f.request,query:'long mix'});await until(()=>f.played.length===1);
    assert.deepEqual(clients,[YOUTUBE_CLIENT_FALLBACK],'the challenged client would only hand out another refused URL');
    assert.equal(f.played[0].input,'https://media.example/signed-1.m4a');
  }finally{await f.manager.destroy();}
});

test('a failed local track is not retried through the extractor',async()=>{
  let refreshed=0;
  const f=fixture({
    prepare:async()=>({stream:true,input:'C:/music/long.flac',duration:7200,limitSec:3600,title:'long file',release(){}}),
    refreshStream:async source=>{refreshed++;return source;},
    customBufferedFactory:()=>{throw new Error('FFmpeg 播放編碼失敗 (1)：No such file or directory');}});
  try{
    await f.manager.play({...f.request,query:'long file'});
    await until(()=>f.notices.some(args=>String(args[1]).includes('No such file or directory')));
    assert.equal(refreshed,0,'a local file has no signed URL to refresh');
  }finally{await f.manager.destroy();}
});

test('a streamed track that dies mid-song refreshes its URL and resumes from where it stopped',async()=>{
  let refreshed=0;const offsets=[];
  const f=fixture({
    prepare:async()=>({kind:'youtube',stream:true,input:'https://media.example/signed-0.m4a',duration:8732,limitSec:3600,
      title:'long mix',url:'https://www.youtube.com/watch?v=JPDnHkA1VVA',release(){}}),
    refreshStream:async source=>{refreshed++;source.input=`https://media.example/signed-${refreshed}.m4a`;return source;},
    customBufferedFactory:(libs,input,opts,createTransport)=>{offsets.push(opts.offsetSeconds);return createTransport(libs,input,opts);}});
  try{
    await f.manager.play({...f.request,query:'long mix'});await until(()=>f.played.length===1);
    f.connections[0].subscribed.emit('error',{resource:f.played[0],message:'FFmpeg 播放編碼失敗 (1)：Server returned 403 Forbidden'});
    await until(()=>f.played.length===2);
    assert.equal(refreshed,1,'the signed URL is refreshed once');
    assert.equal(f.played[1].input,'https://media.example/signed-1.m4a');
    assert.equal(offsets[1],0.02,'playback resumes from the packets already played');
    assert(f.notices.some(args=>String(args[1]).includes('續播')),'the channel is told playback resumed');
  }finally{await f.manager.destroy();}
});

test('duplicate errors during URL refresh keep the song and respect a pause', async () => {
  const refresh = Promise.withResolvers();
  let refreshes = 0;
  const f = fixture({
    prepare: async () => ({ kind: 'youtube', stream: true, input: 'https://media.example/mix', title: 'mix', duration: 7200 }),
    refreshStream: () => { refreshes++; return refresh.promise; },
  });
  try {
    await f.manager.play({ ...f.request, query: 'mix' });
    await until(() => f.played.length === 1);
    const player = f.connections[0].subscribed;
    const failure = { resource: f.played[0], message: 'stream closed' };
    player.emit('error', failure);
    player.emit('error', failure);
    await f.manager.pause(f.request);
    assert.equal(refreshes, 1);
    assert.equal(f.manager.snapshot('guild').title, 'mix');
    refresh.resolve();
    await until(() => f.played.length === 2);
    assert.equal(f.manager.snapshot('guild').state, 'paused');
    assert.equal(player.paused, true);
  } finally { refresh.resolve(); await f.manager.destroy(); }
});

test('skipping a recovering stream lets the following song finish while the old refresh is pending', async () => {
  const refresh = Promise.withResolvers();
  const f = fixture({
    prepare: async query => query === 'mix'
      ? { kind: 'youtube', stream: true, input: 'https://media.example/mix', title: query, duration: 7200 }
      : { input: query + '.flac', title: query },
    refreshStream: () => refresh.promise,
  });
  try {
    for (const query of ['mix', 'second', 'third']) await f.manager.play({ ...f.request, query });
    await until(() => f.played.length === 1);
    const player = f.connections[0].subscribed;
    player.emit('error', { resource: f.played[0], message: 'stream closed' });
    await f.manager.next(f.request);
    await until(() => f.played.length === 2);
    player.stop();
    await until(() => f.played.length === 3);
    refresh.resolve();
    await tick();
    assert.deepEqual(f.played.map(resource => resource.metadata.title), ['mix', 'second', 'third']);
    assert.equal(f.manager.snapshot('guild').title, 'third');
  } finally { refresh.resolve(); await f.manager.destroy(); }
});

test('the panel and encoder changes use packet progress when the voice clock is frozen', async () => {
  const f = fixture({ nativeTransport: true });
  try {
    await f.manager.play({ ...f.request, query: 'track' });
    await until(() => f.played.length === 1);
    f.transports[0].framesRead = 625;
    f.transports[0].snapshot = () => assert.fail('progress must not sort the diagnostic timing window');
    f.played[0].playbackDuration = 0;
    assert.equal(f.manager.snapshot('guild').positionMs, 12500);
    await f.manager.volume({ ...f.request, percent: 40 });
    assert.equal(f.transports[1].offsetSeconds, 12.5);
    f.transports[1].framesRead = 50;
    await f.manager.bitrate({ ...f.request, kbps: 96 });
    assert.equal(f.transports[2].offsetSeconds, 13.5);
  } finally { await f.manager.destroy(); }
});

test('a local track that dies mid-song is not re-extracted',async()=>{
  let refreshed=0;
  const f=fixture({
    prepare:async()=>({input:'C:/music/song.flac',title:'song',release(){}}),
    refreshStream:async source=>{refreshed++;return source;}});
  try{
    await f.manager.play({...f.request,query:'song'});await until(()=>f.played.length===1);
    f.connections[0].subscribed.emit('error',{resource:f.played[0],message:'boom'});
    await until(()=>f.notices.some(args=>String(args[1]).includes('將繼續下一首')));
    assert.equal(refreshed,0,'a local file has no signed URL to refresh');
    assert.equal(f.played.length,1);
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

test('relative volume uses the actual current value in the player lane, clamps at both ends and preserves pause',async()=>{
  const f=fixture({nativeTransport:true});
  try{
    await f.manager.play({...f.request,query:'song'});await until(()=>f.played.length===1);
    assert.match((await f.manager.execute('volume',{...f.request,guildId:'guild',deltaPercent:-10})).message,/50%/);
    await Promise.all([1,2].map(()=>f.manager.execute('volume',{...f.request,guildId:'guild',deltaPercent:-10})));
    assert.equal(f.transports.at(-1).options.volume,0.3);
    await f.manager.pause(f.request);
    await f.manager.execute('volume',{...f.request,guildId:'guild',deltaPercent:10});
    assert.equal(f.transports.at(-1).options.volume,0.4);assert.equal(f.connections[0].subscribed.paused,true);
    await assert.rejects(f.manager.execute('volume',{...f.request,guildId:'guild',senderId:'other',deltaPercent:-10}),/目前所在/);
    await f.manager.volume({...f.request,percent:5});await f.manager.execute('volume',{...f.request,guildId:'guild',deltaPercent:-10});assert.equal(f.transports.at(-1).options.volume,0);
    await f.manager.volume({...f.request,percent:95});await f.manager.execute('volume',{...f.request,guildId:'guild',deltaPercent:10});assert.equal(f.transports.at(-1).options.volume,1);
    assert.match((await f.manager.volume({...f.request,percent:10,deltaPercent:-10})).message,/不能同時指定/);
    assert.equal(f.transports.at(-1).options.volume,1);
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

test('a connection stuck in signalling is rejoined instead of failing the prepared track',async()=>{
  let calls=0;const f=fixture({dropAfterReady:true,recoverVoice:async()=>({attempts:1}),
    ready:async()=>{if(++calls>1)throw Object.assign(new Error('The operation was aborted'),{name:'AbortError',code:'ABORT_ERR'});}});
  try{
    await f.manager.play({...f.request,query:'song'});await until(()=>f.played.length===1);
    assert.equal(calls,2,'the stuck connection was waited on before the rejoin');
    assert.equal(f.played.length,1,'the prepared track still plays after the rejoin');
  }finally{await f.manager.destroy();}
});

test('a voice connection that cannot be rejoined reports the connection, not the abort',async()=>{
  let calls=0;const f=fixture({dropAfterReady:true,recoverVoice:async()=>{throw new Error('語音重連次數已用完');},
    ready:async()=>{if(++calls>1)throw Object.assign(new Error('The operation was aborted'),{name:'AbortError',code:'ABORT_ERR'});}});
  try{
    await f.manager.play({...f.request,query:'song'});
    await until(()=>f.notices.some(([,message])=>message.includes('語音連線中斷')));
    assert(!f.notices.some(([,message])=>message.includes('The operation was aborted')),'the raw abort never reaches the listener');
    assert.equal(f.played.length,0);
  }finally{await f.manager.destroy();}
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

test('the default bitrate follows the voice channel instead of tripling it',async()=>{
  const f=fixture();f.guild.channels.cache.set('voice',{bitrate:16000});
  try{await f.manager.play({...f.request,query:'song'});await until(()=>f.played.length===1);assert.equal(f.played[0].encoder.bitrate,16000);}
  finally{await f.manager.destroy();}
});

test('an explicit bitrate overrides the voice channel setting',async()=>{
  const f=fixture();f.guild.channels.cache.set('voice',{bitrate:16000});
  try{
    await f.manager.play({...f.request,query:'song'});await until(()=>f.played.length===1);
    await f.manager.bitrate({...f.request,kbps:192});
    assert.equal(f.transports[1].options.bitrate,192000);
  }finally{await f.manager.destroy();}
});

test('bitrate rebuild preserves playback position, volume and pause state, and applies to subsequent songs',async()=>{
  const f=fixture({nativeTransport:true});f.guild.channels.cache.set('voice',{bitrate:384000});
  try{
    await f.manager.play({...f.request,query:'first'});await f.manager.play({...f.request,query:'second'});await until(()=>f.played.length===1);
    f.played[0].playbackDuration=12000;
    const result=await f.manager.execute('bitrate',{...f.request,guildId:'guild',kbps:256});
    assert.match(result.message,/目前輸出：256 kbps/);assert.equal(f.transports[1].options.bitrate,256000);
    assert.equal(f.transports[1].offsetSeconds,12);assert.equal(f.transports[1].options.volume,0.6);assert(f.transports[0].destroyed);
    await f.manager.pause(f.request);f.played[1].playbackDuration=1000;
    await f.manager.bitrate({...f.request,kbps:320});assert.equal(f.transports[2].offsetSeconds,13);
    assert.equal(f.connections[0].subscribed.paused,true);assert.match((await f.manager.queue(f.request)).message,/已暫停[\s\S]*second/);
    await f.manager.volume({...f.request,percent:35});assert.equal(f.transports[3].options.bitrate,320000);
    await f.manager.next(f.request);await until(()=>f.played.length===5);assert.equal(f.transports[4].options.bitrate,320000);
    await f.manager.bitrate({...f.request,kbps:32});assert.equal(f.transports[5].options.bitrate,32000);
  }finally{await f.manager.destroy();}
});

test('an explicit bitrate ignores the channel setting, respects the caller, validates values, and avoids redundant rebuilds',async()=>{
  const f=fixture({nativeTransport:true});f.guild.channels.cache.set('voice',{bitrate:64000});
  try{
    await f.manager.play({...f.request,query:'song'});await until(()=>f.played.length===1);
    assert.match((await f.manager.bitrate({...f.request,kbps:128})).message,/目前輸出：128 kbps/);
    assert.match((await f.manager.bitrate({...f.request,kbps:128})).message,/頻道設定：64 kbps/);
    assert.equal(f.played.length,2,'the first change rebuilds the stream');
    await f.manager.bitrate({...f.request,kbps:128});assert.equal(f.played.length,2,'the same rate is a no-op');
    assert.match((await f.manager.bitrate({...f.request,senderId:'other'})).message,/目標碼率：128/);
    await assert.rejects(f.manager.bitrate({...f.request,senderId:'other',kbps:32}),/目前所在/);
    for(const kbps of [0,15,385,NaN,Infinity,64.5,'128'])assert.match((await f.manager.bitrate({...f.request,kbps})).message,/用法/);
    assert.equal(f.played.length,2);
    f.guild.channels.cache.set('voice',{bitrate:256000});await f.manager.bitrate({...f.request,kbps:256});assert.equal(f.transports[2].options.bitrate,256000);
    await f.manager.stop(f.request);await f.manager.play({...f.request,query:'again'});await until(()=>f.played.length===4);
    assert.equal(f.transports[3].options.bitrate,256000);
  }finally{await f.manager.destroy();}
});

test('failed bitrate rebuild restores the old settings and stream',async()=>{
  let calls=0;const f=fixture({nativeTransport:true,customBufferedFactory:async(libs,input,options,create)=>{
    if(++calls===2)throw new Error('fixture encoder failure');return create(libs,input,options);
  }});f.guild.channels.cache.set('voice',{bitrate:256000});
  try{
    await f.manager.play({...f.request,query:'song'});await until(()=>f.played.length===1);
    await assert.rejects(f.manager.bitrate({...f.request,kbps:256}),/fixture encoder/);
    assert.equal(f.transports[0].destroyed,false);assert.equal(f.connections[0].subscribed.paused,false);
    assert.match((await f.manager.bitrate(f.request)).message,/目標碼率：192 kbps[\s\S]*目前輸出：192 kbps/);
  }finally{await f.manager.destroy();}
});

test('stop cancels a bitrate rebuild and cannot resurrect its late resource',async()=>{
  let release,calls=0;const f=fixture({nativeTransport:true,customBufferedFactory:async(libs,input,options,create)=>{
    if(++calls===2)await new Promise(resolve=>{release=resolve;});return create(libs,input,options);
  }});f.guild.channels.cache.set('voice',{bitrate:256000});
  try{
    await f.manager.play({...f.request,query:'song'});await until(()=>f.played.length===1);
    const change=f.manager.execute('bitrate',{...f.request,guildId:'guild',kbps:256});const cancelled=assert.rejects(change,{name:'AbortError'});await until(()=>release);
    await f.manager.execute('stop',{...f.request,guildId:'guild'});await cancelled;release();await until(()=>f.transports.length===2);
    assert(f.transports.every(item=>item.destroyed));assert.equal(f.played.length,1);
  }finally{release?.();await f.manager.destroy();}
});

test('bitrate changes during initial prebuffering replace stale encoding before playback',async()=>{
  let release,calls=0;const f=fixture({nativeTransport:true,customBufferedFactory:async(libs,input,options,create)=>{
    if(++calls===1)await new Promise(resolve=>{release=resolve;});return create(libs,input,options);
  }});f.guild.channels.cache.set('voice',{bitrate:256000});
  try{
    await f.manager.play({...f.request,query:'song'});await until(()=>release);await f.manager.bitrate({...f.request,kbps:256});
    release();await until(()=>f.played.length===1);assert(f.transports[0].destroyed);assert.equal(f.transports[1].options.bitrate,256000);
  }finally{release?.();await f.manager.destroy();}
});

test('stereo default permits 320 kbps, mono caps output without losing target, and position and volume survive',async()=>{
  const f=fixture({nativeTransport:true});f.guild.channels.cache.set('voice',{bitrate:384000});
  try{
    await f.manager.play({...f.request,query:'first'});await f.manager.play({...f.request,query:'second'});await until(()=>f.played.length===1);
    assert.equal(f.transports[0].options.channels,2);assert.equal(f.transports[0].options.bitrate,192000);
    await f.manager.bitrate({...f.request,kbps:320});assert.equal(f.transports[1].options.bitrate,320000);
    assert.match((await f.manager.bitrate(f.request)).message,/目標碼率：320[\s\S]*目前輸出：320/);
    f.played[1].playbackDuration=12340;await f.manager.pause(f.request);
    const result=await f.manager.execute('channels',{...f.request,guildId:'guild',count:1});
    assert.match(result.message,/目前輸出：256 kbps/);assert.match(result.message,/單聲道/);
    assert.equal(f.transports[2].options.channels,1);assert.equal(f.transports[2].options.bitrate,256000);
    assert.equal(f.transports[2].offsetSeconds,12.34);assert.equal(f.transports[2].options.volume,0.6);assert(f.connections[0].subscribed.paused);
    await f.manager.channels({...f.request,count:1});assert.equal(f.played.length,3);
    await f.manager.volume({...f.request,percent:35});assert.equal(f.transports[3].options.channels,1);assert.equal(f.transports[3].options.bitrate,256000);
    await f.manager.next(f.request);await until(()=>f.played.length===5);assert.equal(f.transports[4].options.channels,1);
    await f.manager.channels({...f.request,count:2});assert.equal(f.transports[5].options.bitrate,320000);
    assert.match((await f.manager.bitrate(f.request)).message,/目標碼率：320/);
    f.guild.channels.cache.set('voice',{bitrate:64000});await f.manager.channels({...f.request,count:2});
    assert.equal(f.transports.length,6,'a channel bitrate change alone never rebuilds the stream');
    assert.match((await f.manager.channels(f.request)).message,/頻道設定：64 kbps/);
    await assert.rejects(f.manager.channels({...f.request,senderId:'other',count:1}),/目前所在/);
    assert.match((await f.manager.channels({...f.request,senderId:'other'})).message,/雙聲道/);
    for(const count of [0,3,6,NaN,'2'])assert.match((await f.manager.channels({...f.request,count})).message,/用法/);
  }finally{await f.manager.destroy();}
});

test('failed mono rebuild restores stereo and its effective bitrate',async()=>{
  let calls=0;const f=fixture({nativeTransport:true,customBufferedFactory:async(libs,input,options,create)=>{
    if(++calls===3)throw new Error('fixture encoder failure');return create(libs,input,options);
  }});f.guild.channels.cache.set('voice',{bitrate:384000});
  try{
    await f.manager.play({...f.request,query:'song'});await until(()=>f.played.length===1);await f.manager.bitrate({...f.request,kbps:320});
    await assert.rejects(f.manager.channels({...f.request,count:1}),/fixture encoder/);
    const status=await f.manager.channels(f.request);assert.match(status.message,/目前輸出：320 kbps/);assert.match(status.message,/聲道：2/);
    assert.equal(f.transports[1].destroyed,false);assert.equal(f.connections[0].subscribed.paused,false);
  }finally{await f.manager.destroy();}
});

test('stop cancels a channel-mode rebuild and destroys its late result',async()=>{
  let release,calls=0;const f=fixture({nativeTransport:true,customBufferedFactory:async(libs,input,options,create)=>{
    if(++calls===2)await new Promise(resolve=>{release=resolve;});return create(libs,input,options);
  }});f.guild.channels.cache.set('voice',{bitrate:384000});
  try{
    await f.manager.play({...f.request,query:'song'});await until(()=>f.played.length===1);
    const change=f.manager.execute('channels',{...f.request,guildId:'guild',count:1});const cancelled=assert.rejects(change,{name:'AbortError'});await until(()=>release);
    await f.manager.execute('stop',{...f.request,guildId:'guild'});await cancelled;release();await until(()=>f.transports.length===2);
    assert(f.transports.every(x=>x.destroyed));assert.equal(f.played.length,1);
  }finally{release?.();await f.manager.destroy();}
});

test('mono selected during prebuffering replaces the stale stereo resource',async()=>{
  let release,calls=0;const f=fixture({nativeTransport:true,customBufferedFactory:async(libs,input,options,create)=>{
    if(++calls===1)await new Promise(resolve=>{release=resolve;});return create(libs,input,options);
  }});
  try{
    await f.manager.play({...f.request,query:'song'});await until(()=>release);await f.manager.channels({...f.request,count:1});
    release();await until(()=>f.played.length===1);assert(f.transports[0].destroyed);assert.equal(f.transports[1].options.channels,1);
  }finally{release?.();await f.manager.destroy();}
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

test('native volume rebuild seeks from the current position, preserves queue and ignores retired-resource errors',async()=>{
  const f=fixture({nativeTransport:true});try{
    await f.manager.play({...f.request,query:'first'});await f.manager.play({...f.request,query:'second'});await until(()=>f.played.length===1);
    const old=f.played[0];old.playbackDuration=12340;await f.manager.volume({...f.request,percent:35});
    assert.equal(f.played.length,2);assert.equal(f.transports[1].offsetSeconds,12.34);assert.equal(f.transports[1].options.volume,0.35);
    assert.equal(f.transports[0].destroyed,true);assert.equal(f.played[1].volume,undefined);assert.equal(f.connections[0].subscribed.paused,false);
    f.connections[0].subscribed.emit('error',{resource:old,message:'late retired encoder'});
    f.connections[0].subscribed.emit('stateChange',{resource:old},{status:'idle'});
    await tick();assert.match((await f.manager.queue(f.request)).message,/first[\s\S]*second/);
    f.played[1].playbackDuration=1000;await f.manager.pause(f.request);await f.manager.volume({...f.request,percent:40});
    assert.equal(f.transports[2].offsetSeconds,13.34);assert.match((await f.manager.queue(f.request)).message,/已暫停/);
  }finally{await f.manager.destroy();}
});

test('stop cancels a native volume rebuild and destroys its late resource without resuming playback',async()=>{
  let release,calls=0;const f=fixture({nativeTransport:true,customBufferedFactory:async(libs,input,options,create)=>{
    if(++calls===2)await new Promise(resolve=>{release=resolve;});return create(libs,input,options);
  }});try{
    await f.manager.play({...f.request,query:'song'});await until(()=>f.played.length===1);
    const volume=f.manager.execute('volume',{...f.request,guildId:'guild',percent:30});const cancelled=assert.rejects(volume,{name:'AbortError'});await until(()=>release);
    await f.manager.execute('stop',{...f.request,guildId:'guild'});await cancelled;release();await until(()=>f.transports.length===2);
    await tick();assert(f.transports.every(item=>item.destroyed));assert.equal(f.played.length,1);assert.match((await f.manager.queue(f.request)).message,/空/);
  }finally{release?.();await f.manager.destroy();}
});

test('failed native volume rebuild restores the previous resource, gain and play state',async()=>{
  let calls=0;const f=fixture({nativeTransport:true,customBufferedFactory:async(libs,input,options,create)=>{
    if(++calls===2)throw new Error('fixture encoder failure');return create(libs,input,options);
  }});try{
    await f.manager.play({...f.request,query:'song'});await until(()=>f.played.length===1);
    await assert.rejects(f.manager.volume({...f.request,percent:30}),/fixture encoder/);
    assert.equal(f.transports[0].destroyed,false);assert.equal(f.connections[0].subscribed.paused,false);
    await f.manager.volume({...f.request,percent:60});assert.equal(calls,2);
  }finally{await f.manager.destroy();}
});

test('volume changes during prebuffering replace the stale gain before initial playback',async()=>{
  let release,calls=0;const f=fixture({nativeTransport:true,customBufferedFactory:async(libs,input,options,create)=>{
    if(++calls===1)await new Promise(resolve=>{release=resolve;});return create(libs,input,options);
  }});try{
    await f.manager.play({...f.request,query:'song'});await until(()=>release);await f.manager.volume({...f.request,percent:35});
    release();await until(()=>f.played.length===1);assert.equal(calls,2);assert.equal(f.transports[0].destroyed,true);assert.equal(f.transports[1].options.volume,0.35);
  }finally{release?.();await f.manager.destroy();}
});

test('a paused song stays paused when its replacement resource becomes readable after the volume command returns',async()=>{
  const f=fixture({nativeTransport:true,deferredPlaying:true});try{
    await f.manager.play({...f.request,query:'song'});await until(()=>f.connections[0]?.subscribed?.state.status==='playing');
    await f.manager.pause(f.request);await f.manager.volume({...f.request,percent:35});
    await until(()=>f.connections[0].subscribed.state.status==='playing');assert.equal(f.connections[0].subscribed.paused,true);
    await f.manager.resume(f.request);assert.equal(f.connections[0].subscribed.paused,false);
  }finally{await f.manager.destroy();}
});

test('card controls require the clicker to be in the bot voice channel, while the console path stays open',async()=>{
  const f=fixture();try{
    await f.manager.play({...f.request,query:'song'});await until(()=>f.played.length===1);
    // A card button press always asks the manager to verify the clicker's voice
    // state. Someone who is not in a voice channel, or is in a different one,
    // must not be able to pause the room's playback — the card is readable by the
    // whole text channel.
    assert.deepEqual(await f.manager.control('guild','pause',{userId:'other',requireVoice:true}),
      {ok:false,message:'請先加入機器人目前所在的語音頻道再操作音樂'});
    assert.equal((await f.manager.control('guild','pause',{userId:'absent',requireVoice:true})).ok,false);
    assert.equal((await f.manager.snapshot('guild')).state,'playing');
    // The listener in the bot's channel may control it.
    assert.equal((await f.manager.control('guild','pause',{userId:'user',requireVoice:true})).ok,true);
    assert.equal((await f.manager.snapshot('guild')).state,'paused');
    // The loopback console omits requireVoice entirely and is already gated by a
    // per-boot token, so it must keep working.
    assert.equal((await f.manager.control('guild','resume')).ok,true);
    assert.equal((await f.manager.snapshot('guild')).state,'playing');
  }finally{await f.manager.destroy();}
});

test('the card remove action clears the paused track so the queue can move again',async()=>{
  // 2026-11-19: 🗑️ only removed the card. The paused track kept the room alive,
  // so every later /play queued behind it and never started.
  const f=fixture();try{
    await f.manager.play({...f.request,query:'song'});await until(()=>f.played.length===1);
    assert.equal((await f.manager.control('guild','pause',{userId:'user',requireVoice:true})).ok,true);
    assert.equal(f.manager.snapshot('guild').state,'paused');
    assert.equal((await f.manager.control('guild','stop',{userId:'user',requireVoice:true})).ok,true);
    const cleared=f.manager.snapshot('guild');
    assert.equal(cleared.state,'idle');
    assert.equal(cleared.title,null);
    assert.deepEqual(cleared.queue,[]);
    // The next song starts instead of waiting behind the cleared one.
    await f.manager.play({...f.request,query:'next song'});await until(()=>f.played.length===2);
    assert.equal(f.manager.snapshot('guild').state,'playing');
  }finally{await f.manager.destroy();}
});

test('the clicker voice channel comes from the worker gateway cache, not the interaction payload',async()=>{
  // 2026-11-07: every card button was refused while the clicker sat in the bot's
  // channel. `INTERACTION_CREATE.member` is an APIGuildMember, which carries only
  // deaf/mute — reading `member.voice.channel_id` there is always undefined, so
  // the manager must resolve the voice state from its own client cache.
  const f=fixture();try{
    await f.manager.play({...f.request,query:'song'});await until(()=>f.played.length===1);
    // 'user' is cached in the bot's channel; 'other' is cached elsewhere.
    assert.equal((await f.manager.control('guild','pause',{userId:'user',requireVoice:true})).ok,true);
    assert.equal((await f.manager.control('guild','resume',{userId:'other',requireVoice:true})).ok,false);
    // A member cached after the press is still resolved live, not snapshotted.
    f.guild.voiceStates.cache.set('late',{channelId:'voice'});
    assert.equal((await f.manager.control('guild','resume',{userId:'late',requireVoice:true})).ok,true);
    // With no clicker id there is nothing to resolve, so the press is refused
    // rather than silently allowed.
    assert.equal((await f.manager.control('guild','pause',{userId:'',requireVoice:true})).ok,false);
  }finally{await f.manager.destroy();}
});

test('a voice error with an empty message still logs something actionable',()=>{
  // @discordjs/voice hands back bare socket errors: 2026-11-06 12:54 logged
  // `music.connection.error` with an empty string and no clue what failed.
  assert.equal(describeError(new Error('')),'Error');
  const coded=Object.assign(new Error(''),{code:4006});
  assert.equal(describeError(coded),'Error code=4006');
  const closed=Object.assign(new Error('socket closed'),{closeCode:4014});
  assert.equal(describeError(closed),'socket closed closeCode=4014');
  assert.equal(describeError(new Error('outer',{cause:Object.assign(new Error(''),{closeCode:4014})})),
    'outer cause: Error closeCode=4014');
  assert.equal(describeError('plain text'),'plain text');
  assert.equal(describeError(undefined),'');
});
