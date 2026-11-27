/**
 * The one selection method this build runs: DSH rewrites a relational request
 * into searchable keywords, the rewrite is checked against the search results,
 * and the same model then picks from the verified candidates.
 */
export const MUSIC_SELECTION_METHOD = 'dsh-resolve';

/** How the method is named in the "now playing" notice. */
export const MUSIC_SELECTION_LABEL = 'DSH（查詢解析）';

/**
 * Why a rewrite was not used. These cross the worker RPC as plain data, so they
 * survive a structured clone even though an Error's `code` would not.
 */
export const RESOLUTION_FAILURES = Object.freeze({
  unavailable: '歌名解析未啟用',
  timeout: '歌名解析逾時',
  'no-web': '網搜後端沒有可用結果',
  unparsed: '模型沒有給出可用的歌名',
  unverified: '改寫沒有被搜尋結果佐證',
  error: '歌名解析失敗',
});

/** The most informative reason among the ones both resolution attempts saw. */
const FAILURE_PRECEDENCE = Object.freeze(['unavailable', 'timeout', 'no-web', 'unparsed', 'error', 'unverified']);

export function resolutionFailureFrom(codes) {
  const seen = new Set(Array.isArray(codes) ? codes.filter(Boolean) : []);
  return FAILURE_PRECEDENCE.find(code => seen.has(code)) ?? null;
}

export function resolutionFailureText(code) {
  return RESOLUTION_FAILURES[code] ?? RESOLUTION_FAILURES.error;
}

const PUNCTUATION = /[「」『』"'`‘’“”【】()[\]{}<>《》〈〉·・,，、;；:：!！?？~～\-–—_|/\\]+/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const CANDIDATE_WINDOW = 5;
const MAX_TAIL = 12;

/**
 * Punctuation and width differ between the model's rewrite and a video title,
 * and YouTube titles are full of decoration, so both sides are folded before
 * comparing: NFKC (full-width to half-width), lower case, and punctuation to a
 * space.
 */
function normalizeForMatch(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(PUNCTUATION, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Whether the search results corroborate a rewrite. The uploader's channel name
 * counts as evidence too: an official channel that titles a video "歌手 - 歌名"
 * corroborates the rewrite even when the title alone does not repeat the query.
 *
 * A single glued CJK request ("周杰倫晴天") has no separator to split on, so the
 * only available evidence is a CJK tail shared with a title. Latin tails are
 * excluded — two characters there match almost any title, which would let a
 * guess through.
 */
export function resolutionMatches(resolved, candidates) {
  const target = normalizeForMatch(resolved);
  if (!target) return false;
  const tokens = target.split(' ').filter(Boolean);
  const song = tokens.at(-1) ?? '';
  if (!song) return false;
  const haystacks = (Array.isArray(candidates) ? candidates : []).slice(0, CANDIDATE_WINDOW)
    .map(candidate => normalizeForMatch(`${candidate?.title ?? ''} ${candidate?.artist ?? ''}`))
    .filter(Boolean);
  if (!haystacks.length) return false;
  // The rewrite as a whole, then the song part on its own.
  if (haystacks.some(text => text.includes(target))) return true;
  if (haystacks.some(text => text.includes(song))) return true;
  // Every keyword of two or more characters in one candidate: a title that
  // names the artist and the song in a different order still counts, while a
  // lone artist match (a different song by the same singer) does not.
  const keywords = tokens.filter(token => token.length >= 2);
  if (keywords.length > 1 && haystacks.some(text => keywords.every(keyword => text.includes(keyword)))) return true;
  if (tokens.length === 1) {
    for (let size = Math.min(target.length - 1, MAX_TAIL); size >= 2; size--) {
      const tail = target.slice(-size);
      if ((tail.match(CJK) ?? []).length < 2) break;
      if (haystacks.some(text => text.includes(tail))) return true;
    }
  }
  return false;
}
