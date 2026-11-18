import fs from 'node:fs';
import path from 'node:path';

/** How many trailing diary paragraphs to read. */
const TAIL_PARAGRAPHS = 2;

/** Hard cap on the rendered block, in characters. */
const MAX_CHARS = 800;

/** Below this, a sentence-boundary cut is not worth taking. */
const MIN_CUT = 200;

/**
 * Read the whale's public diary tail as one bounded context block.
 *
 * The whale plugin writes `whale-diary.md` (narrative, meant to be read) and
 * `whale-diary-private.md` (preference calibration). Only the public one is
 * shared: the private file is the whale's own working notes and must not leak
 * into another agent's prompt.
 *
 * @param options.dshHome - DSH home; defaults to `DSH_HOME`.
 * @param options.logger - Host logger for a read that failed.
 * @returns async `() => string | null`.
 */
export function createWhaleDiaryProvider({ dshHome, logger } = {}) {
  const home = dshHome ?? process.env.DSH_HOME ?? '';
  const file = path.join(home, 'whale-diary.md');
  return async () => {
    try {
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, '');
      const paragraphs = raw.split(/\n\s*\n/u).map((p) => p.trim()).filter(Boolean);
      if (paragraphs.length === 0) return null;
      let tail = paragraphs.slice(-TAIL_PARAGRAPHS).join('\n\n').replace(/\s+/gu, ' ');
      if (tail.length > MAX_CHARS) {
        const cut = tail.lastIndexOf('。', MAX_CHARS);
        tail = tail.slice(0, cut > MIN_CUT ? cut + 1 : MAX_CHARS);
      }
      return tail.trim() || null;
    } catch (error) {
      // A missing diary is normal (fresh install); only a real read error is worth a line.
      if (error?.code !== 'ENOENT') {
        logger?.warn?.('[dsh-im] whale diary read failed:', error?.message ?? error);
      }
      return null;
    }
  };
}
