import test from 'node:test';
import assert from 'node:assert/strict';
import { MUSIC_PLAYBACK_PROFILE, playbackBitrate, playbackEncoderArgs } from '../src/channels/discord/music-encoder.mjs';
import { voiceBitrate } from '../src/channels/discord/music-transport.mjs';

test('the default target is 192 kbps stereo', () => {
  assert.equal(MUSIC_PLAYBACK_PROFILE.bitrate, 192000);
  assert.equal(MUSIC_PLAYBACK_PROFILE.channels, 2);
});

test('a plain 64 kbps channel is the default target, and an explicit rate overrides it', () => {
  // The channel bitrate is a client-side setting Discord does not enforce, but
  // sending three times the configured rate costs bandwidth on every listener's
  // uplink. The default follows the channel; `/music bitrate` is the override.
  assert.equal(voiceBitrate(64000, 192000, 2), 64000);
  assert.equal(voiceBitrate(undefined, 192000, 2), 192000);
  assert.equal(voiceBitrate(64000, 192000, 2, { respectChannel: false }), 192000);
});

test('the codec ceiling still applies', () => {
  assert.equal(playbackBitrate(1000000, 2), 384000);
  assert.equal(playbackBitrate(1000000, 1), 256000);
  assert.equal(voiceBitrate(384000, 320000, 2), 320000);
});

test('the encoder keeps a fixed 20 ms packet size at the requested rate', () => {
  const args = playbackEncoderArgs('/tmp/a.flac', { bitrate: 192000 });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at('-vbr'), 'off', 'CBR keeps every 20 ms packet the same size for UDP pacing');
  assert.equal(at('-b:a'), '192000');
  assert.equal(at('-application'), 'audio');
  assert.equal(at('-frame_duration'), '20');
});

test('encoder search effort only rises once the rate has room for it', () => {
  // 64 kbps is bit-starved: cl 10 buys 0.02 dB for 1.3x the CPU, so stay cheap.
  // At 128 kbps and above it buys ~1.1 dB of SNR and still runs 7.8x real time.
  const level = (bitrate) => {
    const args = playbackEncoderArgs('/tmp/a.flac', { bitrate });
    return args[args.indexOf('-compression_level') + 1];
  };
  assert.equal(level(64000), '0');
  assert.equal(level(96000), '0');
  assert.equal(level(128000), '10');
  assert.equal(level(192000), '10');
  assert.equal(level(384000), '10');
});

test('a seek keeps the encoder flags and adds the offset', () => {
  const args = playbackEncoderArgs('/tmp/a.flac', { bitrate: 192000, offsetSeconds: 12.5 });
  assert.equal(args[args.indexOf('-ss') + 1], '12.500');
  assert.equal(args[args.indexOf('-vbr') + 1], 'off');
});
