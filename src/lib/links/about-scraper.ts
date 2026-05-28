import type { DeclaredLink } from '../types.js';
import type { ResourceCache } from '../cache/resource-cache.js';
import type { RateLimiter } from '../rate-limit/rate-limiter.js';
import { getRegistry } from '../platform-registry.js';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const YT_INITIAL_DATA_RE = /(?:var\s+ytInitialData|window\["ytInitialData"\])\s*=\s*({.+?});<\/script>/s;

const REDIRECT_URL_RE = /youtube\.com\/redirect\?.*?(?:q|url)=([^&]+)/i;

export interface AboutPageResult {
  links: DeclaredLink[];
  handle?: string;
}

export async function scrapeAboutPage(
  channelUrl: string,
  channelId: string,
  cache: ResourceCache,
  limiter: RateLimiter,
): Promise<AboutPageResult> {
  // 1. Check cache
  const scrapeStatus = await cache.getScrapeStatus(channelId);
  if (scrapeStatus === 'success') {
    const cached = await cache.getDeclaredLinks(channelId);
    if (cached) return { links: cached.filter((l) => l.source === 'formal_links') };
  }
  if (scrapeStatus === 'blocked') return { links: [] };

  // 2. Acquire rate limiter token
  const release = await limiter.acquire('youtube-web');
  try {
    // 3. Fetch about page
    const aboutUrl = channelUrl.replace(/\/$/, '') + '/about';
    const resp = await fetch(aboutUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!resp.ok) {
      limiter.reportFailure('youtube-web');
      await cache.setScrapeStatus(channelId, 'failed');
      return { links: [] };
    }

    limiter.reportSuccess('youtube-web');
    const html = await resp.text();

    // 4. Parse ytInitialData
    const dataMatch = html.match(YT_INITIAL_DATA_RE);
    if (!dataMatch) {
      await cache.setScrapeStatus(channelId, 'blocked');
      return { links: [] };
    }

    let ytData: unknown;
    try {
      ytData = JSON.parse(dataMatch[1]);
    } catch {
      await cache.setScrapeStatus(channelId, 'failed');
      return { links: [] };
    }

    // 5. Walk the JSON tree for channel links
    const rawLinks = findChannelLinks(ytData);
    const links = classifyLinks(rawLinks);

    // 6. Extract handle from channel metadata
    const handle = extractHandle(ytData);

    await cache.setScrapeStatus(channelId, 'success');
    return { links, handle };
  } catch {
    limiter.reportFailure('youtube-web');
    await cache.setScrapeStatus(channelId, 'failed');
    return { links: [] };
  } finally {
    release();
  }
}

function findChannelLinks(data: unknown): string[] {
  const urls: string[] = [];
  walkTree(data, (key, value) => {
    if (key === 'channelExternalLinkViewModel' && typeof value === 'object' && value !== null) {
      const link = value as Record<string, unknown>;
      // Extract the URL from the link object
      const linkUrl = extractUrl(link);
      if (linkUrl) urls.push(linkUrl);
    }
  });
  return urls;
}

function walkTree(obj: unknown, callback: (key: string, value: unknown) => void): void {
  if (obj === null || obj === undefined || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      walkTree(item, callback);
    }
    return;
  }

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    callback(key, value);
    walkTree(value, callback);
  }
}

function extractUrl(linkObj: Record<string, unknown>): string | null {
  // The link structure has nested content with commandRuns that contain onTap URLs
  let url: string | null = null;

  walkTree(linkObj, (key, value) => {
    if (url) return;
    if (key === 'url' && typeof value === 'string' && value.includes('http')) {
      url = decodeRedirectUrl(value);
    }
    // Also check for innertubeCommand/urlEndpoint
    if (key === 'urlEndpoint' && typeof value === 'object' && value !== null) {
      const endpoint = value as Record<string, unknown>;
      if (typeof endpoint.url === 'string') {
        url = decodeRedirectUrl(endpoint.url);
      }
    }
  });

  return url;
}

function decodeRedirectUrl(url: string): string {
  const redirectMatch = url.match(REDIRECT_URL_RE);
  if (redirectMatch) {
    try {
      return decodeURIComponent(redirectMatch[1]);
    } catch {
      return url;
    }
  }
  return url;
}

function extractHandle(ytData: unknown): string | undefined {
  let handle: string | undefined;
  walkTree(ytData, (key, value) => {
    if (handle) return;
    if (key === 'channelHandleText' && typeof value === 'object' && value !== null) {
      const text = (value as { simpleText?: string }).simpleText;
      if (text && text.startsWith('@')) {
        handle = text;
      }
    }
  });
  return handle;
}

function classifyLinks(urls: string[]): DeclaredLink[] {
  const registry = getRegistry();
  const links: DeclaredLink[] = [];
  for (const url of urls) {
    const lower = url.toLowerCase();

    // Registry-based classification
    const platform = registry.classifyForMatch(url);
    if (platform) {
      links.push({ platform, url, source: 'formal_links' });
      continue;
    }

    // LBRY protocol/TV fallback
    if (lower.startsWith('lbry://') || lower.includes('lbry.tv/@')) {
      links.push({ platform: 'lbry', url, source: 'formal_links' });
      continue;
    }

    // Not a target platform — still include as unknown for completeness
    links.push({ platform: 'unknown', url, source: 'formal_links' });
  }
  return links;
}
