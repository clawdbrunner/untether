import type { ResourceCache } from '../cache/resource-cache.js';
import type { RateLimiter } from '../rate-limit/rate-limiter.js';

const OG_IMAGE_RE = /<meta\s+property="og:image"\s+content="([^"]+)"/i;
const TWITTER_IMAGE_RE = /<meta\s+name="twitter:image"\s+content="([^"]+)"/i;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Scrape a YouTube channel page for the avatar URL (og:image).
 * Works without any API key — the channel page is public.
 */
export async function scrapeChannelAvatar(
  channelUrl: string,
  channelId: string,
  cache: ResourceCache,
  limiter: RateLimiter,
): Promise<string | null> {
  const cached = await cache.getEnrichment(channelId);
  if (cached?.avatarUrl) return cached.avatarUrl;

  const release = await limiter.acquire('youtube-web');
  try {
    const resp = await fetch(channelUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) return null;

    const html = await resp.text();

    // Try og:image first (most reliable)
    let match = html.match(OG_IMAGE_RE);
    if (match) return match[1];

    // Fallback: twitter:image
    match = html.match(TWITTER_IMAGE_RE);
    if (match) return match[1];

    return null;
  } catch {
    return null;
  } finally {
    release();
  }
}
