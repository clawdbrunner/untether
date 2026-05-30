import type { ChannelCandidate } from '../types.js';
import type { PlatformAdapter } from '../adapters/adapter-interface.js';
import type { RateLimiter } from '../rate-limit/rate-limiter.js';
import type { ResourceCache } from '../cache/resource-cache.js';
import type { PluginConfig } from '../types.js';
import { PluginSandbox } from './runtime.js';
import * as cheerio from 'cheerio';

/**
 * A PlatformAdapter backed by a Grayjay plugin.
 * HTTP calls are made from the host (through the rate limiter).
 * Data parsing happens in a sandboxed isolated-vm.
 */
export class GrayjayPluginAdapter implements PlatformAdapter {
  readonly id: 'bitchute' | 'rumble';
  private sandbox: PluginSandbox;
  private pluginSource: string | null = null;

  constructor(
    private config: PluginConfig,
    private cache: ResourceCache,
    private limiter: RateLimiter,
    private sourceKey: string,
  ) {
    this.id = config.platformId as 'bitchute' | 'rumble';
    this.sandbox = new PluginSandbox();
  }

  async initialize(pluginSource: string): Promise<void> {
    this.pluginSource = pluginSource;
  }

  async searchChannels(query: string): Promise<ChannelCandidate[]> {
    const cached = await this.cache.getSearchResults(this.sourceKey, query);
    if (cached) return cached;

    const results = this.id === 'bitchute'
      ? await this.searchBitChute(query)
      : await this.searchRumble(query);

    await this.cache.setSearchResults(this.sourceKey, query, results);
    return results;
  }

  async resolveChannel(url: string): Promise<ChannelCandidate | null> {
    return this.id === 'bitchute'
      ? await this.resolveBitChute(url)
      : await this.resolveRumble(url);
  }

  async extractBackReferences(
    candidate: ChannelCandidate,
    youtubeChannelId: string,
    youtubeHandle?: string,
  ): Promise<boolean> {
    if (!candidate.description) return false;
    const desc = candidate.description.toLowerCase();
    if (desc.includes(youtubeChannelId.toLowerCase())) return true;
    if (desc.includes('youtube.com/channel/' + youtubeChannelId.toLowerCase())) return true;
    if (youtubeHandle) {
      const handle = youtubeHandle.replace(/^@/, '').toLowerCase();
      if (desc.includes('youtube.com/@' + handle)) return true;
      if (desc.includes('@' + handle)) return true;
    }
    return false;
  }

  // ---- BitChute ----

  private async searchBitChute(query: string): Promise<ChannelCandidate[]> {
    const release = await this.limiter.acquire(this.sourceKey);
    try {
      const resp = await fetch('https://api.bitchute.com/api/beta/search/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset: 0, limit: 20, query, sensitivity_id: 'normal', sort: 'new' }),
      });

      if (!resp.ok) { this.limiter.reportFailure(this.sourceKey); return []; }
      this.limiter.reportSuccess(this.sourceKey);

      const data = await resp.json();
      const channels = data?.channels ?? [];
      return channels.map((ch: Record<string, unknown>) => this.mapBitChuteChannel(ch));
    } catch {
      this.limiter.reportFailure(this.sourceKey);
      return [];
    } finally {
      release();
    }
  }

  private async resolveBitChute(url: string): Promise<ChannelCandidate | null> {
    const match = url.match(/bitchute\.com\/channel\/([A-Za-z0-9_\-]+)\/?/);
    if (!match) return null;
    const channelId = match[1];

    const release = await this.limiter.acquire(this.sourceKey);
    try {
      const resp = await fetch('https://api.bitchute.com/api/beta/channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_id: channelId }),
      });

      if (!resp.ok) return null;
      const data = await resp.json();
      return this.mapBitChuteChannel(data);
    } catch {
      return null;
    } finally {
      release();
    }
  }

  private mapBitChuteChannel(ch: Record<string, unknown>): ChannelCandidate {
    const channelUrl = ch.channel_url as string | undefined;
    return {
      url: channelUrl?.startsWith('http') ? channelUrl : `https://www.bitchute.com${channelUrl ?? ''}`,
      handle: (ch.channel_id as string) || undefined,
      displayName: (ch.channel_name as string) || 'Unknown',
      avatarUrl: (ch.thumbnail_url as string) || undefined,
      subscriberCount: (ch.subscriber_count as number) || undefined,
      description: (ch.description as string) || undefined,
      platform: 'bitchute',
    };
  }

  // ---- Rumble ----

  private async searchRumble(query: string): Promise<ChannelCandidate[]> {
    const release = await this.limiter.acquire(this.sourceKey);
    try {
      const searchUrl = `https://rumble.com/search/channel?q=${encodeURIComponent(query)}`;
      const resp = await fetch(searchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      });

      if (!resp.ok) { this.limiter.reportFailure(this.sourceKey); return []; }
      this.limiter.reportSuccess(this.sourceKey);

      const html = await resp.text();
      return this.parseRumbleSearchResults(html);
    } catch {
      this.limiter.reportFailure(this.sourceKey);
      return [];
    } finally {
      release();
    }
  }

  private async resolveRumble(url: string): Promise<ChannelCandidate | null> {
    let aboutUrl = url.replace(/\/$/, '');
    if (!aboutUrl.includes('/about')) aboutUrl += '/about';

    const release = await this.limiter.acquire(this.sourceKey);
    try {
      const resp = await fetch(aboutUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      });

      if (!resp.ok) return null;
      const html = await resp.text();
      return this.parseRumbleChannelPage(url, html);
    } catch {
      return null;
    } finally {
      release();
    }
  }

  private parseRumbleSearchResults(html: string): ChannelCandidate[] {
    const $ = cheerio.load(html);
    const results: ChannelCandidate[] = [];

    $('article').each((_, article) => {
      const el = $(article);
      const link = el.find('a[href]').first();
      const h3 = el.find('h3 span').first();
      const name = h3.text().trim();
      const href = link.attr('href') || '';
      const imgUrl = el.find('img').first().attr('src') || '';

      const spans = el.find('h3').parent().find('span');
      let subs: number | undefined;
      const subsText = spans.last().text().trim();
      if (subsText) {
        const parsed = parseInt(subsText.replace(/[.,]/g, '').split(' ')[0]);
        if (!isNaN(parsed)) subs = parsed;
      }

      if (name && href) {
        results.push({
          url: href.startsWith('http') ? href : `https://rumble.com${href}`,
          displayName: name,
          avatarUrl: imgUrl || undefined,
          subscriberCount: subs,
          platform: 'rumble',
        });
      }
    });

    return results;
  }

  private parseRumbleChannelPage(url: string, html: string): ChannelCandidate | null {
    const $ = cheerio.load(html);

    const name = $('.channel-header--title h1').first().text().trim();
    const imgUrl = $('.channel-header--img').first().attr('src') || undefined;
    const subsText = $('.channel-header--title span').last().text().trim();
    const description = $('.channel-about--description').first().text().trim();

    let subs: number | undefined;
    if (subsText) {
      const parsed = parseInt(subsText.replace(/[.,]/g, '').split(' ')[0]);
      if (!isNaN(parsed)) subs = parsed;
    }

    if (!name) return null;

    return {
      url: url.replace(/\/about\/?$/, ''),
      displayName: name,
      avatarUrl: imgUrl,
      subscriberCount: subs,
      description: description || undefined,
      platform: 'rumble',
    };
  }

  dispose(): void {
    this.sandbox.dispose();
  }
}
