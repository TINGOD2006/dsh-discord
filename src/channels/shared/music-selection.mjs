export const MUSIC_SELECTION_METHODS = Object.freeze({
  youtube: 'YouTube 首選',
  tfidf: 'TF-IDF＋餘弦相似度',
  dsh: 'DSH（十選一）',
  'dsh-resolve': 'DSH（查詢解析）',
  'dsh-web': 'DSH（原生網搜）',
});

export const DEFAULT_MUSIC_SELECTION_METHOD = 'dsh';

/** True only for a method this build can actually run. */
export function isMusicSelectionMethod(value) {
  return typeof value === 'string' && Object.hasOwn(MUSIC_SELECTION_METHODS, value);
}

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

function countTerms(text) {
  const counts = new Map();
  const words = text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const word of words) {
    const characters = Array.from(word);
    for (const size of [1, 2, 3]) {
      for (let start = 0; start + size <= characters.length; start++) {
        const term = characters.slice(start, start + size).join('');
        counts.set(term, (counts.get(term) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/** Rank by the course demo's candidate-local TF-IDF, breaking ties by search order. */
export function selectTfidfCandidate(query, candidates) {
  const documents = candidates.map(({ title, artist }) => countTerms(title + ' ' + artist));
  const documentFrequency = new Map();
  for (const document of documents) {
    for (const term of document.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const idf = new Map(Array.from(documentFrequency, ([term, count]) => [
    term, Math.log((documents.length + 1) / (count + 1)) + 1,
  ]));

  function vector(counts) {
    const weights = new Map();
    let sumSquares = 0;
    for (const [term, count] of counts) {
      if (!idf.has(term)) continue;
      const weight = count * idf.get(term);
      weights.set(term, weight);
      sumSquares += weight * weight;
    }
    return { weights, norm: Math.sqrt(sumSquares) };
  }

  const search = vector(countTerms(query));
  let bestIndex = 0;
  let bestScore = -1;
  for (const [index, document] of documents.entries()) {
    const candidate = vector(document);
    let dot = 0;
    for (const [term, weight] of search.weights) {
      dot += weight * (candidate.weights.get(term) ?? 0);
    }
    const denominator = search.norm * candidate.norm;
    const score = denominator > 0 ? dot / denominator : 0;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return candidates[bestIndex];
}
