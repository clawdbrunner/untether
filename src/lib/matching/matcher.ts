import type {
  YouTubeChannel,
  ChannelCandidate,
  DeclaredLink,
  MatchResult,
  ScoredCandidate,
} from '../types.js';
import type { PlatformAdapter } from '../adapters/adapter-interface.js';
import type { ResourceCache } from '../cache/resource-cache.js';
import type { RateLimiter } from '../rate-limit/rate-limiter.js';
import { scoreCandidate } from './confidence.js';
import { normalizeName } from './name-utils.js';
import { computePHash, isLowEntropyAvatar } from './phash.js';

export async function matchChannel(
  ytChannel: YouTubeChannel,
  platform: 'peertube' | 'odysee' | 'dailymotion' | 'bitchute' | 'rumble',
  adapter: PlatformAdapter,
  declaredLinks: DeclaredLink[],
  cache: ResourceCache,
  limiter: RateLimiter,
): Promise<MatchResult> {
  let candidates: ScoredCandidate[] = [];
  const seen = new Set<string>();

  // Compute YouTube avatar hash (cached)
  let ytAvatarHash: string | undefined;
  let lowEntropy = false;
  if (ytChannel.avatarUrl) {
    ytAvatarHash = await cache.getAvatarHash(ytChannel.avatarUrl) ?? undefined;
    if (!ytAvatarHash) {
      try {
        lowEntropy = await isLowEntropyAvatar(ytChannel.avatarUrl);
        if (!lowEntropy) {
          ytAvatarHash = await computePHash(ytChannel.avatarUrl);
          await cache.setAvatarHash(ytChannel.avatarUrl, ytAvatarHash);
        }
      } catch {
        // Avatar processing failed — skip this signal
      }
    }
  }

  // Step 1: Check declared links for this platform
  const platformLinks = declaredLinks.filter((l) => l.platform === platform || (platform === 'odysee' && l.platform === 'lbry'));

  for (const declaredLink of platformLinks) {
    try {
      const resolved = await adapter.resolveChannel(declaredLink.url);
      if (resolved) {
        const candHash = await getCandidateAvatarHash(resolved.avatarUrl, cache);
        const scored = scoreCandidate(ytChannel, resolved, declaredLink, false, ytAvatarHash, candHash, lowEntropy);
        candidates.push(scored);
        seen.add(resolved.url.toLowerCase());
      }
    } catch {
      // Resolution failed
    }
  }

  // Step 2: Search for candidates
  let searchResults: ChannelCandidate[];
  try {
    searchResults = await adapter.searchChannels(ytChannel.title);
  } catch (err) {
    if (err instanceof Error && err.message.includes('Circuit breaker open')) {
      process.stderr.write(`[matcher] Skipping ${platform} — circuit breaker open\n`);
      return { youtubeChannel: ytChannel, platform, candidates: [] };
    }
    throw err;
  }

  // Also search by handle if different from title
  if (ytChannel.handle && normalizeName(ytChannel.handle) !== normalizeName(ytChannel.title)) {
    try {
      const handleResults = await adapter.searchChannels(ytChannel.handle);
      searchResults = [...searchResults, ...handleResults];
    } catch {
      // Handle search failed
    }
  }

  // Deduplicate and score
  for (const candidate of searchResults) {
    const key = candidate.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // Check back-reference
    let hasBackRef = false;
    try {
      hasBackRef = await adapter.extractBackReferences(candidate, ytChannel.id, ytChannel.handle);
    } catch {
      // Back-reference check failed
    }

    // Compute candidate avatar hash
    const candHash = await getCandidateAvatarHash(candidate.avatarUrl, cache);

    const scored = scoreCandidate(ytChannel, candidate, undefined, hasBackRef, ytAvatarHash, candHash, lowEntropy);
    candidates.push(scored);
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  // Filter out candidates below minimum confidence threshold
  candidates = candidates.filter(c => c.score >= 0.3);

  return {
    youtubeChannel: ytChannel,
    platform,
    candidates: candidates.slice(0, 5),
  };
}

async function getCandidateAvatarHash(avatarUrl: string | undefined, cache: ResourceCache): Promise<string | undefined> {
  if (!avatarUrl) return undefined;

  const cached = await cache.getAvatarHash(avatarUrl);
  if (cached) return cached;

  try {
    const hash = await computePHash(avatarUrl);
    await cache.setAvatarHash(avatarUrl, hash);
    return hash;
  } catch {
    return undefined;
  }
}
