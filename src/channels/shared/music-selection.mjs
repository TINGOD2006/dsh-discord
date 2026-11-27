/**
 * The one selection method this build runs: DSH rewrites a relational request
 * into searchable keywords, the rewrite is checked against the search results,
 * and the same model then picks from the verified candidates.
 */
export const MUSIC_SELECTION_METHOD = 'dsh-resolve';

/** How the method is named in the "now playing" notice. */
export const MUSIC_SELECTION_LABEL = 'DSH（查詢解析）';

/**
 * Whether the search results corroborate a rewrite: the resolved song name has
 * to appear in one of the first three titles. A rewrite that no result mentions
 * is a guess, and the caller keeps the original query instead.
 */
export function resolutionMatches(resolved, candidates) {
  const tokens = String(resolved ?? '').split(/\s+/).filter(Boolean);
  const song = tokens.at(-1) ?? '';
  if (!song) return false;
  return (Array.isArray(candidates) ? candidates : []).slice(0, 3)
    .some(candidate => String(candidate?.title ?? '').includes(song));
}
