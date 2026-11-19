import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { musicTools } from '../src/channels/discord/music-audio.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-music-tools-'));
}

test('tools copied into the plugin folder are found without environment variables', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'ffmpeg.exe'), '');
    writeFileSync(join(dir, 'yt-dlp.exe'), '');
    const tools = musicTools({ audioUsbRoot: join(dir, 'no-audio-usb'), localToolsDir: dir });
    assert.equal(tools.ffmpeg, join(dir, 'ffmpeg.exe'));
    assert.equal(tools.ytDlp, join(dir, 'yt-dlp.exe'));
    // A tool that is not there still falls back to PATH, not to a missing path.
    assert.equal(tools.ffprobe, 'ffprobe');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicit environment variable wins over the plugin folder copy', () => {
  const dir = tempDir();
  const explicit = join(dir, 'explicit-ffmpeg.exe');
  const previous = process.env.DSK_DISCORD_FFMPEG;
  try {
    writeFileSync(join(dir, 'ffmpeg.exe'), '');
    writeFileSync(explicit, '');
    process.env.DSK_DISCORD_FFMPEG = explicit;
    const tools = musicTools({ audioUsbRoot: join(dir, 'no-audio-usb'), localToolsDir: dir });
    assert.equal(tools.ffmpeg, explicit);
  } finally {
    if (previous === undefined) delete process.env.DSK_DISCORD_FFMPEG;
    else process.env.DSK_DISCORD_FFMPEG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the AudioUsbStudio reference still works when the plugin folder is empty', () => {
  const dir = tempDir();
  try {
    const bin = join(dir, 'release', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'ffprobe.exe'), '');
    const tools = musicTools({ audioUsbRoot: dir, localToolsDir: join(dir, 'empty') });
    assert.equal(tools.ffprobe, join(bin, 'ffprobe.exe'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
