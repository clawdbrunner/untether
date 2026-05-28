const COMMON_SUFFIXES = /\b(official|tv|hd|vevo|music|gaming|channel)\b/gi;
const TOPIC_SUFFIX = /\s*-\s*topic$/i;
const EMOJI_RE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;
const NON_ALNUM_RE = /[^a-z0-9\s]/g;
const MULTI_SPACE_RE = /\s+/g;
const TRAILING_DIGITS_RE = /\d+$/;

export function normalizeName(name: string): string {
  let n = name.toLowerCase();
  n = n.replace(EMOJI_RE, '');
  n = n.replace(TOPIC_SUFFIX, '');
  n = n.replace(COMMON_SUFFIXES, '');
  n = n.replace(NON_ALNUM_RE, ' ');
  n = n.replace(MULTI_SPACE_RE, ' ');
  return n.trim();
}

export function normalizeHandle(handle: string): string {
  let h = handle.replace(/^@/, '').toLowerCase();
  h = h.replace(TRAILING_DIGITS_RE, '');
  return h;
}

export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);

  if (!na || !nb) return 0;

  // Exact match
  if (na === nb) return 1.0;

  // One is a substring of the other
  if (na.includes(nb) || nb.includes(na)) return 0.85;

  // Levenshtein-based similarity
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 0;

  const similarity = 1 - dist / maxLen;
  return Math.min(similarity * 0.8, 0.8); // cap at 0.8 for fuzzy
}

export function handleSimilarity(a: string, b: string): number {
  const ha = normalizeHandle(a);
  const hb = normalizeHandle(b);

  if (!ha || !hb) return 0;
  if (ha === hb) return 1.0;
  if (ha.includes(hb) || hb.includes(ha)) return 0.85;

  const dist = levenshtein(ha, hb);
  const maxLen = Math.max(ha.length, hb.length);
  if (maxLen === 0) return 0;

  return Math.min((1 - dist / maxLen) * 0.8, 0.8);
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  if (m === 0) return n;
  if (n === 0) return m;

  // Use single-row optimization
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,     // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}
