import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Rotate before the file grows past this size. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export function resolveImLogFile(channel = 'discord', env = process.env) {
  const home = env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  return join(home, 'logs', `dsh-${channel}.log`);
}

/** Render one log argument without throwing on cycles. */
function render(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Append-only JSONL logger for one IM channel. Logging never throws: a failed
 * write is swallowed so diagnostics cannot break message delivery.
 */
export function createImFileLogger({ file, channel = 'discord', maxBytes = DEFAULT_MAX_BYTES, env = process.env } = {}) {
  if (env.DSH_DISCORD_LOG === '0') return null;
  const target = file ?? resolveImLogFile(channel, env);
  let ready = false;
  const rotateIfNeeded = () => {
    try {
      if (statSync(target).size < maxBytes) return;
      renameSync(target, `${target}.1`);
    } catch {
      // A missing file or a locked rotation target is not fatal.
    }
  };
  const write = (level, event, args) => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      channel,
      event,
      message: args.map(render).join(' '),
    });
    try {
      if (!ready) {
        mkdirSync(dirname(target), { recursive: true });
        ready = true;
      }
      rotateIfNeeded();
      appendFileSync(target, `${line}\n`, 'utf8');
    } catch {
      // Diagnostics must never break delivery.
    }
  };
  return {
    file: target,
    event(name, data) {
      write('event', name, data === undefined ? [] : [data]);
    },
    info: (...args) => write('info', 'log', args),
    warn: (...args) => write('warn', 'log', args),
    error: (...args) => write('error', 'log', args),
    debug: (...args) => write('debug', 'log', args),
  };
}

/**
 * Wrap the host logger so every line is mirrored into the channel log file.
 * The original logger keeps working, so the console behaviour is unchanged.
 */
export function withFileLogger(logger, options = {}) {
  const file = createImFileLogger(options);
  if (!file) return logger ?? console;
  const call = (level) => (...args) => {
    file[level](...args);
    logger?.[level]?.(...args);
  };
  return {
    ...(logger ?? {}),
    file: file.file,
    event: (name, data) => {
      file.event(name, data);
      logger?.event?.(name, data);
    },
    info: call('info'),
    warn: call('warn'),
    error: call('error'),
    debug: call('debug'),
  };
}
