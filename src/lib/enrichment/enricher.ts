import type { YouTubeChannel, PipelineConfig } from '../types.js';
import type { ResourceCache } from '../cache/resource-cache.js';
import type { RateLimiter } from '../rate-limit/rate-limiter.js';
import { batchEnrichChannels } from './youtube-api.js';
import { ytdlpEnrich } from './ytdlp-service.js';
import { scrapeChannelAvatar } from './avatar-scraper.js';

export async function enrichChannels(
  channels: YouTubeChannel[],
  config: PipelineConfig,
  cache: ResourceCache,
  limiter: RateLimiter,
): Promise<void> {
  // 1. Check cache for all channels first
  const needsEnrichment: YouTubeChannel[] = [];
  for (const ch of channels) {
    const cached = await cache.getEnrichment(ch.id);
    if (cached) {
      applyEnrichment(ch, cached);
    } else {
      needsEnrichment.push(ch);
    }
  }

  if (needsEnrichment.length === 0) return;

  // 2. If API key provided, use batch API enrichment
  if (config.youtubeApiKey) {
    for (let i = 0; i < needsEnrichment.length; i += 50) {
      const batch = needsEnrichment.slice(i, i + 50);
      const release = await limiter.acquire('youtube-api');
      try {
        const apiResults = await batchEnrichChannels(batch, config.youtubeApiKey);
        for (const ch of batch) {
          const data = apiResults.get(ch.id);
          if (data) {
            applyEnrichment(ch, data);
            await cache.setEnrichment(ch.id, data);
          }
        }
      } finally {
        release();
      }
    }
  }

  // 3. Fall back to yt-dlp for any channels still missing description
  const stillMissing = needsEnrichment.filter((ch) => !ch.description);
  for (const ch of stillMissing) {
    const release = await limiter.acquire('youtube-web');
    try {
      const data = await ytdlpEnrich(ch.url, undefined, limiter);
      if (data) {
        applyEnrichment(ch, data);
        await cache.setEnrichment(ch.id, data);
      }
    } finally {
      release();
    }
  }

  // 4. Final fallback: scrape channel page for avatar (og:image)
  const stillNoAvatar = needsEnrichment.filter((ch) => !ch.avatarUrl);
  if (stillNoAvatar.length > 0) {
    process.stderr.write(`[enricher] Scraping avatars for ${stillNoAvatar.length} channels from channel pages\n`);
  }
  for (const ch of stillNoAvatar) {
    try {
      const avatarUrl = await scrapeChannelAvatar(ch.url, ch.id, cache, limiter);
      if (avatarUrl) {
        ch.avatarUrl = avatarUrl;
        const existing = await cache.getEnrichment(ch.id) ?? {};
        await cache.setEnrichment(ch.id, { ...existing, avatarUrl });
      }
    } catch {
      // Avatar scrape failed — channel will show placeholder
    }
  }
}

function applyEnrichment(channel: YouTubeChannel, data: Partial<YouTubeChannel>): void {
  if (data.description && !channel.description) channel.description = data.description;
  if (data.avatarUrl && !channel.avatarUrl) channel.avatarUrl = data.avatarUrl;
  if (data.subscriberCount != null && channel.subscriberCount == null) {
    channel.subscriberCount = data.subscriberCount;
  }
  if (data.handle && !channel.handle) channel.handle = data.handle.replace(/^@/, '');


}
