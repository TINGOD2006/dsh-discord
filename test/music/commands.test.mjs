import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationCommandPayloads, commandTextFromInteraction, handleApplicationCommand } from '../../src/channels/discord/discord-commands.mjs';
import { isMusicCommand, parseMusicCommand, runMusicCommand } from '../../src/channels/shared/music-commands.mjs';
import { isControlCommand } from '../../src/channels/shared/control-command.mjs';
import { createDshMusicSelector, selectedCandidate } from '../../src/channels/discord/music-dsh.mjs';
import { DiscordHarnessBridge } from '../../src/channels/discord/discord-bridge.mjs';

test('existing AI stop and skip are never parsed as music', () => {
  for (const name of ['stop', 'skip']) {
    assert.equal(isControlCommand('/' + name), true);
    assert.equal(isMusicCommand('/' + name), false);
    assert.equal(parseMusicCommand('/' + name), null);
  }
  const commands = applicationCommandPayloads();
  assert.equal(commands.find(c => c.name === 'stop').description, 'Stop the task running in this chat');
  assert.equal(commands.find(c => c.name === 'skip').description, 'Skip the current thinking (short spelling of /stop)');
  assert.deepEqual(parseMusicCommand('/music skip'), { name: 'next', argument: '' });
  assert.deepEqual(parseMusicCommand('/music stop'), { name: 'stop', argument: '' });
});

test('native music subcommands retain their arguments while legacy command text stays identical', () => {
  assert.equal(commandTextFromInteraction({data: {name: 'music', options: [{type: 1, name: 'volume', options: [{type: 4, name: 'percent', value: 35}]}]}}), '/music volume 35');
  assert.equal(commandTextFromInteraction({data: {name: 'music', options: [{type: 1, name: 'play', options: [{type: 3, name: 'query', value: '初音ミク song'}]}]}}), '/music play 初音ミク song');
  assert.equal(commandTextFromInteraction({data: {name: 'skip', options: []}}), '/skip');
  const native = applicationCommandPayloads().find(c => c.name === 'music');
  assert(native.options.some(option => option.name === 'skip'));
  assert(native.options.some(option => option.name === 'stop'));
  assert(native.options.some(option => option.name === 'status'));
  assert.deepEqual(parseMusicCommand('/music status'),{name:'status',argument:''});
});

test('music network status stays in the music namespace and forwards its caller',async()=>{
  let caller;
  const result=await runMusicCommand('/music status',{}, {}, 'key',{conversationId:'channel',senderId:'sender',
    music:{status:async request=>{caller=request;return{message:'UDP status'};}}});
  assert.equal(result.message,'UDP status');assert.deepEqual(caller,{channelId:'channel',senderId:'sender'});
});

test('music dispatcher forwards channel and sender to controls without touching the chat harness', async () => {
  const calls = [];
  const harness = new Proxy({}, { get() { throw new Error('AI harness must remain untouched by music stop'); } });
  const music = { stop: async args => { calls.push(args); return {message: 'stopped'}; }, next: async args => { calls.push(args); return {message: 'next'}; } };
  await runMusicCommand('/music stop', harness, {}, 'key', {music, conversationId: 'channel', senderId: 'sender'});
  await runMusicCommand('/music skip', harness, {}, 'key', {music, conversationId: 'channel', senderId: 'sender'});
  assert.deepEqual(calls, [{channelId: 'channel', senderId: 'sender'}, {channelId: 'channel', senderId: 'sender'}]);
});

test('music controls reject extra text instead of executing an accidental command', async () => {
  let calls=0;
  for (const text of ['/music stop extra', '/music skip\n/stop', '/pause song']) {
    const result=await runMusicCommand(text,{}, {},'key',{conversationId:'channel',senderId:'sender',music:{execute:async()=>{calls++;}}});
    assert.match(result.message,/不接受額外文字/);
  }
  assert.equal(calls,0);
});

test('registered command names are unique and AI/music parsers never claim the same root',()=>{
  const commands=applicationCommandPayloads();const names=commands.map(command=>command.name);
  assert.equal(new Set(names).size,names.length);
  for(const name of names) assert.equal(isControlCommand('/'+name)&&isMusicCommand('/'+name),false,name);
  assert.equal(commands.find(command=>command.name==='play').options[0].required,true);
});

for (const command of [
  { data: { name: 'music', options: [{ type: 1, name: 'stop' }] }, text: '/music stop' },
  { data: { name: 'play', options: [{ type: 3, name: 'query', value: 'song' }] }, text: '/play song' },
  { data: { name: 'stop' }, text: '/stop' },
]) test(`native ${command.text} acknowledgement and answer are public before and after execution`, async () => {
  const order=[];
  await handleApplicationCommand({type: 2, id: 'interaction', token: 'fixture', channel_id: 'channel', guild_id: 'guild', member:{user:{id:'sender'}},
    data:command.data}, {
    applicationId:'app',api:{createInteractionResponse:async(id,token,payload)=>{
      assert.equal(payload.type,5);assert.equal((payload.data?.flags??0)&64,0);order.push('ack');
    },updateInteractionOriginal:async(app,token,payload)=>{
      assert.equal(payload.content,'ok');assert.deepEqual(payload.allowed_mentions,{parse:[]});order.push('reply');
    }},
    bridge:{runNativeCommand:async(text,args)=>{assert.equal(text,command.text);assert.equal(args.senderId,'sender');order.push('execute');return 'ok';}},
  });
  assert.deepEqual(order,['ack','execute','reply']);
});

const candidates=[{id:'jNQXAC9IVRw',title:'one'},{id:'dQw4w9WgXcQ',title:'two'}];
test('DSH chooses only a verified candidate in a separate music session', async () => {
  const calls=[];
  const select=createDshMusicSelector({createSession:async args=>{calls.push(args.conversationKey);return 'music-session';},ask:async(id,prompt)=>{assert.equal(id,'music-session');assert(prompt.includes('候選排序器'));return '{"videoId":"dQw4w9WgXcQ"}';}});
  const result=await select({query:'song',candidates,guildId:'guild'});
  assert.equal(result.candidate.id,candidates[1].id);assert.equal(result.selection,'dsh');assert.deepEqual(calls,['discord-music:guild']);
  assert.equal(selectedCandidate('{"videoId":"https://evil.invalid"}',candidates),null);
});

test('DSH timeout falls back to a real candidate and caller abort never starts a song', async () => {
  const select=createDshMusicSelector({createSession:async()=> 'session',ask:async()=>new Promise(()=>{})},{timeoutMs:10});
  const result=await select({query:'song',candidates,guildId:'guild'});
  assert.equal(result.selection,'search-fallback');assert.equal(result.candidate.id,candidates[0].id);
  const controller=new AbortController();controller.abort();
  await assert.rejects(select({query:'song',candidates,guildId:'guild',signal:controller.signal}),{name:'AbortError'});
});

test('production scoped harness creates only a dedicated music cwd through public RPC', async () => {
  let created;
  const select=createDshMusicSelector({
    createSession:async()=>{throw new Error('bot-scoped createSession must not replace the music workspace');},
    rpc:async(method,payload)=>{assert.equal(method,'session.create');created=payload;return {sessionId:'isolated-music'};},
    ask:async(id)=>{assert.equal(id,'isolated-music');return '{"videoId":"jNQXAC9IVRw"}';},
  });
  const result=await select({query:'song',candidates,guildId:'guild'});
  assert.equal(result.selection,'dsh');assert.match(created.cwd.replaceAll('\\','/'),/dsh-discord\/\.dsh-im\/music\/dsh-workspace$/);
});

test('real Discord bridge routes music independently with context enhancement disabled', async () => {
  const controller=new AbortController();const musicCalls=[];let aiStops=0;
  const bridge=new DiscordHarnessBridge({signal:controller.signal,bot:{sendText:async()=>{}},state:{sessionFor:()=> 'existing-chat-session'},
    harness:{workspaceSession:()=>({stopActiveTurn:async()=>{aiStops++;return true;}})},
    musicTools:{stop:async args=>{musicCalls.push(args);return {message:'music stopped'};}},
  });
  try{
    assert.equal(await bridge.runNativeCommand('/music stop',{conversationId:'channel',senderId:'sender'}),'music stopped');
    assert.deepEqual(musicCalls,[{channelId:'channel',senderId:'sender'}]);assert.equal(aiStops,0);
    await bridge.runNativeCommand('/stop',{conversationId:'channel',senderId:'sender'});assert.equal(aiStops,1);assert.equal(musicCalls.length,1);
  }finally{controller.abort();}
});
