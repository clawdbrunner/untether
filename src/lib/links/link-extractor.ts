import type { YouTubeChannel, DeclaredLink } from '../types.js';
import type { ResourceCache } from '../cache/resource-cache.js';
import type { RateLimiter } from '../rate-limit/rate-limiter.js';
import { parseDescriptionLinks } from './description-parser.js';
import { scrapeAboutPage } from './about-scraper.js';

export async function extractDeclaredLinks(
  channel: YouTubeChannel,
  cache: ResourceCache,
  limiter: RateLimiter,
): Promise<DeclaredLink[]> {
  // Check cache first
  const cached = await cache.getDeclaredLinks(channel.id);
  if (cached) return cached;

  const allLinks: DeclaredLink[] = [];

  // 1. Parse description links (sync, no network)
  if (channel.description) {
    const descLinks = parseDescriptionLinks(channel.description);
    allLinks.push(...descLinks);
  }

  // 2. Scrape about page for formal links + handle (async)
  try {
    const aboutResult = await scrapeAboutPage(channel.url, channel.id, cache, limiter);
    allLinks.push(...aboutResult.links);
    // Apply handle from about page if not already set
    if (aboutResult.handle && !channel.handle) {
      channel.handle = aboutResult.handle;
    }
  } catch {
    // Graceful degradation — description-only links
  }

  // 3. Deduplicate by URL
  const seen = new Set<string>();
  const deduped = allLinks.filter((link) => {
    const key = link.url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Cache the combined results
  await cache.setDeclaredLinks(channel.id, deduped);

  return deduped;
}
