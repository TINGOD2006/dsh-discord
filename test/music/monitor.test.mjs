import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeMusicLog, classifyMusicLog, monitorMusic } from '../../scripts/monitor-music.mjs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const ts='2026-10-23T16:42:30.000Z';
const line=(event,message,level='event')=>JSON.stringify({ts,event,message,level})+'\n';
test('monitor observes reload and command sync without exposing IDs or log contents',()=>{
  const text=line('commands.global-cleared','{"applicationId":"private-app"}')+line('commands.synced','{"guildId":"private-guild"}');
  const result=consumeMusicLog(text,null,Date.parse(ts));
  assert.equal(result.report.observedGuildsSinceReload,1);
  assert(!JSON.stringify(result.report).includes('private-'));
  assert.equal(consumeMusicLog(text,result.state,Date.parse(ts)+5000).report.notifications.length,0);
});
test('sensitive error messages are classified and never copied to monitor output',()=>{
  const classified=classifyMusicLog({ts,event:'log',level:'warn',message:'music.track.failed yt-dlp download failed token=DO_NOT_PRINT secret=PRIVATE_VALUE'});
  assert.equal(classified.cause,'download');
  assert(!JSON.stringify(classified).includes('DO_NOT_PRINT'));assert(!JSON.stringify(classified).includes('PRIVATE_VALUE'));
});
test('playback submission and DSH milestones are deduplicated and never claim audible success',()=>{
  const text=line('log','music.playing {"selection":"dsh","title":"private song"}','info');
  const result=consumeMusicLog(text,null,Date.parse(ts));
  assert.equal(result.report.dshSelectionObserved,true);assert.equal(result.report.audiblePlaybackConfirmed,false);
  assert(!JSON.stringify(result.report).includes('private song'));
  assert.equal(consumeMusicLog(text+text,result.state,Date.parse(ts)).report.notifications.length,0);
});

test('a missing log alerts once and recovery can establish a fresh baseline',async()=>{
  const base=resolve('work/monitor-tests');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'case-'));
  try{
    const options={logFile:join(dir,'absent.log'),stateFile:join(dir,'state.json')};
    assert.equal((await monitorMusic(options)).changed,true);
    assert.equal((await monitorMusic(options)).changed,false);
    await writeFile(options.logFile,JSON.stringify({ts:new Date().toISOString(),event:'commands.synced',message:'{"guildId":"private"}'})+'\n');
    const recovered=await monitorMusic(options);assert.equal(recovered.observedGuildsSinceReload,1);assert.equal(recovered.status,undefined);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('voice health statistics stay private and regular samples do not produce notifications',()=>{
  const text=line('log','music.transport.stats {"udpPingMs":42,"wsPingMs":25,"sourceStarved":0,"privateToken":"never-print"}','info');
  const result=consumeMusicLog(text,null,Date.parse(ts));
  assert.equal(result.report.transport.udpPingMs,42);assert.equal(result.report.transport.rtpPacketLoss,null);
  assert.equal(result.report.notifications.length,0);assert(!JSON.stringify(result.report).includes('never-print'));
  const warning=consumeMusicLog(text+line('log','music.transport.degraded {"udpPingMs":600,"sourceStarved":3}','warn'),result.state,Date.parse(ts));
  assert.equal(warning.report.notifications[0].code,'transport-quality');
});

test('a text playback notice failure is not reported as a UDP or audio failure',()=>{
  const event=classifyMusicLog({ts,event:'log',level:'warn',message:'music.notice.failed Discord POST returned invalid JSON'});
  assert.equal(event.cause,'music-notification');
});
