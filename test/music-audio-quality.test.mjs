import test from 'node:test';
import assert from 'node:assert/strict';
import { MUSIC_PLAYBACK_PROFILE, playbackBitrate, playbackEncoderArgs } from '../src/channels/discord/music-encoder.mjs';
import { voiceBitrate } from '../src/channels/discord/music-transport.mjs';

test('the default target is 192 kbps stereo', () => {
  assert.equal(MUSIC_PLAYBACK_PROFILE.bitrate, 192000);
  assert.equal(MUSIC_PLAYBACK_PROFILE.channels, 2);
});

test('a plain 64 kbps channel no longer drags the stream down to 64 kbps', () => {
  // The channel bitrate is a client-side setting; clamping to it made every
  // unboosted server sound worse than the source.
  assert.equal(voiceBitrate(64000, 192000, 2), 192000);
  assert.equal(voiceBitrate(undefined, 192000, 2), 192000);
});

test('the codec ceiling still applies', () => {
  assert.equal(playbackBitrate(1000000, 2), 384000);
  assert.equal(playbackBitrate(1000000, 1), 256000);
  assert.equal(voiceBitrate(384000, 320000, 2), 320000);
});

test('the encoder runs VBR at maximum effort', () => {
  const args = playbackEncoderArgs('/tmp/a.flac', { bitrate: 192000 });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at('-vbr'), 'on');
  assert.equal(at('-compression_level'), '10');
  assert.equal(at('-b:a'), '192000');
  assert.equal(at('-application'), 'audio');
  assert.equal(at('-frame_duration'), '20');
});

test('a seek keeps the encoder flags and adds the offset', () => {
  const args = playbackEncoderArgs('/tmp/a.flac', { bitrate: 192000, offsetSeconds: 12.5 });
  assert.equal(args[args.indexOf('-ss') + 1], '12.500');
  assert.equal(args[args.indexOf('-vbr') + 1], 'on');
});
