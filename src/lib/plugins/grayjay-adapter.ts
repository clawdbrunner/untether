import type { ChannelCandidate } from '../types.js';
import type { PlatformAdapter } from '../adapters/adapter-interface.js';
import type { RateLimiter } from '../rate-limit/rate-limiter.js';
import type { ResourceCache } from '../cache/resource-cache.js';
import type { PluginConfig } from '../types.js';
import { PluginRuntime } from './runtime.js';
import * as cheerio from 'cheerio';

export type AdapterMode = 'plugin' | 'direct';

type HttpResponse = { isOk: boolean; code: number; body: string };

/**
 * A PlatformAdapter backed by a Grayjay plugin with direct-adapter fallback.
 *
 * - Plugin mode: loads the actual Grayjay plugin JS and executes it in a vm sandbox
 * - Direct mode: our own HTTP + parsing implementation (reliable fallback)
 */
export class GrayjayPluginAdapter implements PlatformAdapter {
  readonly id: 'bitchute' | 'rumble';
  private runtime: PluginRuntime | null = null;
  private pluginSource: string | null = null;
  private mode: AdapterMode;

  constructor(
    private config: PluginConfig,
    private cache: ResourceCache,
    private limiter: RateLimiter,
    private sourceKey: string,
    mode: AdapterMode = 'plugin',
  ) {
    this.id = config.platformId as 'bitchute' | 'rumble';
    this.mode = mode;
  }

  async initialize(pluginSource: string): Promise<void> {
    this.pluginSource = pluginSource;

    if (this.mode === 'plugin') {
      try {
        this.runtime = new PluginRuntime({
          sourceKey: this.sourceKey,
          limiter: this.limiter,
          cpuTimeoutMs: 10000,
        });
        await this.runtime.loadAndEnable(pluginSource);
        process.stderr.write(`[adapter:${this.sourceKey}] Plugin mode active\n`);
      } catch (err) {
        process.stderr.write(`[adapter:${this.sourceKey}] Plugin load failed, falling back to direct mode: ${err}\n`);
        this.mode = 'direct';
        this.runtime = null;
      }
    }
  }

  get activeMode(): AdapterMode {
    return this.mode;
  }

  async searchChannels(query: string): Promise<ChannelCandidate[]> {
    const cached = await this.cache.getSearchResults(this.sourceKey, query);
    if (cached) return cached;

    let results: ChannelCandidate[];

    if (this.mode === 'plugin' && this.runtime) {
      results = await this.searchViaPlugin(query);
      if (results.length === 0) {
        process.stderr.write(`[adapter:${this.sourceKey}] Plugin returned 0 results, trying direct fallback\n`);
        results = await this.searchDirect(query);
      }
    } else {
      results = await this.searchDirect(query);
    }

    if (results.length > 0) await this.cache.setSearchResults(this.sourceKey, query, results);
    return results;
  }

  async resolveChannel(url: string): Promise<ChannelCandidate | null> {
    if (this.mode === 'plugin' && this.runtime) {
      const result = await this.resolveViaPlugin(url);
      if (result) return result;
    }
    return this.resolveDirect(url);
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

  // =====================================================
  // PLUGIN PATH — executes Grayjay plugin in sandbox
  // =====================================================

  private async searchViaPlugin(query: string): Promise<ChannelCandidate[]> {
    if (!this.runtime) return [];

    try {
      const prefetched = await this.prefetchForSearch(query);
      const rawResults = this.runtime.executeSearchChannels(query, prefetched);
      return rawResults.map((ch) => this.mapPluginResult(ch as Record<string, unknown>));
    } catch (err) {
      process.stderr.write(`[adapter:${this.sourceKey}] Plugin search failed: ${err}\n`);
      return [];
    }
  }

  private async resolveViaPlugin(url: string): Promise<ChannelCandidate | null> {
    if (!this.runtime) return null;

    try {
      const prefetched = await this.prefetchForResolve(url);
      const result = this.runtime.executeGetChannel(url, prefetched);
      if (!result) return null;
      return this.mapPluginResult(result);
    } catch (err) {
      process.stderr.write(`[adapter:${this.sourceKey}] Plugin resolve failed: ${err}\n`);
      return null;
    }
  }

  private mapPluginResult(ch: Record<string, unknown>): ChannelCandidate {
    const id = ch.id as Record<string, unknown> | string | undefined;
    return {
      url: (ch.url as string) || '',
      handle: (typeof id === 'object' && id !== null ? (id.id as string) : (id as string)) || undefined,
      displayName: (ch.name as string) || '',
      avatarUrl: (ch.thumbnail as string) || undefined,
      subscriberCount: (ch.subscribers as number) || undefined,
      description: (ch.description as string) || undefined,
      platform: this.id,
    };
  }

  // =====================================================
  // PRE-FETCH — makes HTTP calls that the plugin will need
  // =====================================================

  private async prefetchForSearch(query: string): Promise<Map<string, HttpResponse>> {
    const map = new Map<string, HttpResponse>();

    if (this.id === 'bitchute') {
      const url = 'https://api.bitchute.com/api/beta/search/channels';
      const body = JSON.stringify({ offset: 0, limit: 50, query, sensitivity_id: 'normal', sort: 'new' });

      const resp = await this.rateLimitedFetch('POST', url, body, { 'Content-Type': 'application/json' });
      const respBody = await resp.text();

      map.set(`POST:${url}:${body}`, { isOk: resp.ok, code: resp.status, body: respBody });
      map.set(`POST:${url}`, { isOk: resp.ok, code: resp.status, body: respBody });
    } else if (this.id === 'rumble') {
      const url = `https://rumble.com/search/channel?q=${encodeURIComponent(query)}`;

      const resp = await this.rateLimitedFetch('GET', url, null, {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      });
      const respBody = await resp.text();

      map.set(`GET:${url}`, { isOk: resp.ok, code: resp.status, body: respBody });
    }

    return map;
  }

  private async prefetchForResolve(url: string): Promise<Map<string, HttpResponse>> {
    const map = new Map<string, HttpResponse>();

    if (this.id === 'bitchute') {
      const match = url.match(/bitchute\.com\/channel\/([A-Za-z0-9_\-]+)\/?/);
      if (match) {
        const channelId = match[1];
        const apiUrl = 'https://api.bitchute.com/api/beta/channel';
        const body = JSON.stringify({ channel_id: channelId });

        const resp = await this.rateLimitedFetch('POST', apiUrl, body, { 'Content-Type': 'application/json' });
        const respBody = await resp.text();

        map.set(`POST:${apiUrl}:${body}`, { isOk: resp.ok, code: resp.status, body: respBody });
        map.set(`POST:${apiUrl}`, { isOk: resp.ok, code: resp.status, body: respBody });
      }
    } else if (this.id === 'rumble') {
      let aboutUrl = url.replace(/\/$/, '');
      if (!aboutUrl.includes('/about')) aboutUrl += '/about';

      const resp = await this.rateLimitedFetch('GET', aboutUrl, null, {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      });
      const respBody = await resp.text();

      map.set(`GET:${aboutUrl}`, { isOk: resp.ok, code: resp.status, body: respBody });
      // Also cache the non-about URL key in case the plugin normalizes differently
      map.set(`GET:${url}`, { isOk: resp.ok, code: resp.status, body: respBody });
    }

    return map;
  }

  private async rateLimitedFetch(
    method: string,
    url: string,
    body: string | null,
    headers: Record<string, string>,
  ): Promise<Response> {
    return this.limiter.fetchWithProxy(this.sourceKey, url, {
      method,
      headers,
      body,
    });
  }

  // =====================================================
  // DIRECT PATH — our own HTTP + parsing (fallback)
  // =====================================================

  private async searchDirect(query: string): Promise<ChannelCandidate[]> {
    if (this.id === 'bitchute') return this.searchBitChuteDirect(query);
    return this.searchRumbleDirect(query);
  }

  private async resolveDirect(url: string): Promise<ChannelCandidate | null> {
    if (this.id === 'bitchute') return this.resolveBitChuteDirect(url);
    return this.resolveRumbleDirect(url);
  }

  // ---- BitChute direct ----

  private async searchBitChuteDirect(query: string): Promise<ChannelCandidate[]> {
    try {
      const resp = await this.rateLimitedFetch('POST',
        'https://api.bitchute.com/api/beta/search/channels',
        JSON.stringify({ offset: 0, limit: 20, query, sensitivity_id: 'normal', sort: 'new' }),
        { 'Content-Type': 'application/json' },
      );
      if (!resp.ok) return [];
      const data = await resp.json() as { channels?: Record<string, unknown>[] };
      return (data?.channels ?? []).map((ch) => this.mapBitChuteChannel(ch));
    } catch {
      return [];
    }
  }

  private async resolveBitChuteDirect(url: string): Promise<ChannelCandidate | null> {
    const match = url.match(/bitchute\.com\/channel\/([A-Za-z0-9_\-]+)\/?/);
    if (!match) return null;
    try {
      const resp = await this.rateLimitedFetch('POST',
        'https://api.bitchute.com/api/beta/channel',
        JSON.stringify({ channel_id: match[1] }),
        { 'Content-Type': 'application/json' },
      );
      if (!resp.ok) return null;
      const ch = await resp.json() as Record<string, unknown>;
      return this.mapBitChuteChannel(ch);
    } catch {
      return null;
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

  // ---- Rumble direct ----

  private async searchRumbleDirect(query: string): Promise<ChannelCandidate[]> {
    try {
      const resp = await this.rateLimitedFetch('GET',
        `https://rumble.com/search/channel?q=${encodeURIComponent(query)}`,
        null,
        { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      );
      if (!resp.ok) return [];
      const html = await resp.text();
      return this.parseRumbleSearchHtml(html);
    } catch {
      return [];
    }
  }

  private async resolveRumbleDirect(url: string): Promise<ChannelCandidate | null> {
    let aboutUrl = url.replace(/\/$/, '');
    if (!aboutUrl.includes('/about')) aboutUrl += '/about';
    try {
      const resp = await this.rateLimitedFetch('GET', aboutUrl, null,
        { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      );
      if (!resp.ok) return null;
      const html = await resp.text();
      return this.parseRumbleChannelHtml(url, html);
    } catch {
      return null;
    }
  }

  private parseRumbleSearchHtml(html: string): ChannelCandidate[] {
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

  private parseRumbleChannelHtml(url: string, html: string): ChannelCandidate | null {
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
    this.runtime?.dispose();
  }
}
