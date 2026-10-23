import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DiscordHarnessBridge } from '../../src/channels/discord/discord-bridge.mjs';
import { DiscordRuntime } from '../../src/channels/discord/discord-runtime.mjs';
import { TurnScheduler } from '../../src/channels/shared/turn-scheduler.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 2));
async function until(check) { for (let i=0;i<300;i++) { if(check())return;await tick(); } throw new Error('Fixture did not settle'); }
function state() { const seen=new Set();return {hasSeen:id=>seen.has(id),markSeen:async id=>{seen.add(id);},sessionFor:()=> 'chat'}; }
const message=(id,senderId)=>({messageId:id,senderId,kind:'group',conversationId:'room',guildId:'guild',content:id,addressed:true,
  plainText:true,images:[],files:[],replyTarget:{channelId:'room'}});

test('Discord FIFO keeps separate @ turns in arrival order across owners and follow-ups',async()=>{
  const lifetime=new AbortController(),prompts=[];let finish;let steering=0;
  const bridge=new DiscordHarnessBridge({signal:lifetime.signal,state:state(),bot:{sendText:async()=>{}},chatOrder:'fifo',ownerUserId:'owner',
    coalesceWindowMs:20,autoSteerSameSender:true,autoSteerLimit:10,
    harness:{workspaceSession:()=>({sessionExists:async()=>true,ask:async prompt=>{prompts.push(prompt);if(prompts.length===1)await new Promise(resolve=>{finish=resolve;});return 'answer';}}),
      steerActiveTurn:async()=>{steering++;return true;}},
  });
  const tasks=[];
  try{
    tasks.push(bridge.accept(message('first','a')));await until(()=>finish);
    tasks.push(bridge.accept(message('second','b'),{busyMessageMode:'steer'}));
    tasks.push(bridge.accept(message('third','owner')));
    tasks.push(bridge.accept(message('fourth','a')));
    for(let i=5;i<=12;i++)tasks.push(bridge.accept(message(`turn-${i}`,i%2?'owner':'a')));
    finish();await Promise.all(tasks);await bridge.waitForIdle();
    assert.deepEqual(prompts,['first','second','third','fourth',...Array.from({length:8},(_,i)=>`turn-${i+5}`)]);assert.equal(steering,0);
  }finally{finish?.();lifetime.abort();}
});

test('slow first-channel routing cannot let later @chat overtake it, while music stays independent',async()=>{
  let socket,releaseRoute,calls=0,stops=0;const replies=[];
  const runtime=new DiscordRuntime({config:{platformId:'bot',botId:'fixture'},token:'fixture-only',state:state(),harness:{ensureRunning:async()=>{},
    workspaceSession:()=>({stopActiveTurn:async()=>{stops++;return true;}})},
    logger:{info(){},warn(){},error(){}},
    createMusicManager:()=>({execute:async()=>({message:'music status'}),destroy:async()=>{}}),
    createApi:()=>({getCurrentUser:async()=>({id:'bot',bot:true}),getGatewayBot:async()=>({url:'wss://fixture.invalid'}),getCurrentApplication:async()=>({id:'app'}),
      putGlobalApplicationCommands:async()=>[],addOwnReaction:async()=>{},removeOwnReaction:async()=>{},getChannel:async()=>{if(++calls===1)await new Promise(resolve=>{releaseRoute=resolve;});return{id:'room',type:0};},
      createMessage:async args=>{if(args.content==='music status'||args.content.includes('已连接 DeepSeek Harness'))replies.push(args.replyToMessageId);return{id:'fixture-reply'};}}),
    createWebSocket:()=>{socket=new EventEmitter();socket.readyState=1;socket.send=()=>{};socket.close=()=>{socket.readyState=3;};
      setTimeout(()=>socket.emit('message',{data:JSON.stringify({op:0,t:'READY',d:{}})}),0);return socket;},
  });
  const deliver=(id,text)=>socket.emit('message',{data:JSON.stringify({op:0,t:'MESSAGE_CREATE',d:{id,channel_id:'room',guild_id:'guild',
    author:{id:'user'},mentions:[{id:'bot'}],content:'<@bot> '+text}})});
  try{
    await runtime.start();deliver('first','/help');await until(()=>releaseRoute);
    deliver('second','/help');deliver('music','/music queue');await until(()=>replies.includes('music'));
    deliver('control','/stop');await until(()=>stops===1);
    assert(!replies.includes('second'));releaseRoute();await until(()=>replies.includes('first')&&replies.includes('second'));
    assert.deepEqual(replies,['music','first','second']);
  }finally{releaseRoute?.();await runtime.stop();}
});

test('the shared scheduler keeps its existing priority policy unless FIFO is explicitly selected',async()=>{
  const scheduler=new TurnScheduler(),order=[];let release;
  const first=scheduler.submit('chat',{senderId:'a',priority:1,text:'first',run:async()=>{order.push('first');await new Promise(resolve=>{release=resolve;});}});
  await until(()=>release);
  const ordinary=scheduler.submit('chat',{senderId:'b',priority:1,text:'ordinary',run:()=>{order.push('ordinary');}});
  const owner=scheduler.submit('chat',{senderId:'owner',priority:3,text:'owner',run:()=>{order.push('owner');}});
  release();await Promise.all([first,ordinary,owner]);assert.deepEqual(order,['first','owner','ordinary']);
});
