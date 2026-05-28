import type { ChannelCandidate } from '../types.js';
import type { PlatformAdapter } from './adapter-interface.js';
import type { ResourceCache } from '../cache/resource-cache.js';
import type { RateLimiter } from '../rate-limit/rate-limiter.js';

interface SepiaChannelResult {
  displayName: string;
  name: string;
  url: string;
  host: string;
  followersCount?: number;
  avatars?: Array<{ path: string; width?: number }>;
  description?: string;
}

interface SepiaSearchResponse {
  total: number;
  data: SepiaChannelResult[];
}

// PeerTube URL patterns:
// https://<instance>/video-channels/<name>
// https://<instance>/c/<name>
// https://<instance>/a/<account>
const PEERTUBE_URL_RE = /^https?:\/\/([^/]+)\/(?:video-channels|c|a|channels|accounts)\/([^/?#]+)/i;

export class PeerTubeAdapter implements PlatformAdapter {
  readonly id = 'peertube' as const;

  constructor(
    private searchHosts: string[] = ['search.joinpeertube.org'],
    private cache: ResourceCache,
    private limiter: RateLimiter,
  ) {}

  async searchChannels(query: string): Promise<ChannelCandidate[]> {
    // Check cache
    const cached = await this.cache.getSearchResults('peertube', query);
    if (cached) return cached;

    const release = await this.limiter.acquire('peertube');
    try {
      const host = this.searchHosts[0];
      const url = `https://${host}/api/v1/search/video-channels?q=${encodeURIComponent(query)}&count=15`;

      const resp = await fetch(url, {
        headers: { Accept: 'application/json' },
      });

      if (!resp.ok) {
        this.limiter.reportFailure('peertube');
        return [];
      }

      this.limiter.reportSuccess('peertube');
      const data: SepiaSearchResponse = await resp.json();
      const candidates = data.data.map((item) => this.mapToCandidate(item));

      await this.cache.setSearchResults('peertube', query, candidates);
      return candidates;
    } catch {
      this.limiter.reportFailure('peertube');
      return [];
    } finally {
      release();
    }
  }

  async resolveChannel(url: string): Promise<ChannelCandidate | null> {
    const match = url.match(PEERTUBE_URL_RE);
    if (!match) return null;

    const [, host, name] = match;

    const release = await this.limiter.acquire('peertube');
    try {
      const apiUrl = `https://${host}/api/v1/video-channels/${encodeURIComponent(name)}`;
      const resp = await fetch(apiUrl, {
        headers: { Accept: 'application/json' },
      });

      if (!resp.ok) {
        this.limiter.reportFailure('peertube');
        return null;
      }

      this.limiter.reportSuccess('peertube');
      const data: SepiaChannelResult = await resp.json();
      return this.mapToCandidate({ ...data, host });
    } catch {
      this.limiter.reportFailure('peertube');
      return null;
    } finally {
      release();
    }
  }

  async extractBackReferences(
    candidate: ChannelCandidate,
    youtubeChannelId: string,
    youtubeHandle?: string,
  ): Promise<boolean> {
    if (!candidate.description) return false;

    const desc = candidate.description.toLowerCase();

    // Check for YouTube channel URL
    if (desc.includes(youtubeChannelId.toLowerCase())) return true;
    if (desc.includes('youtube.com/channel/' + youtubeChannelId.toLowerCase())) return true;

    // Check for handle reference
    if (youtubeHandle) {
      const handle = youtubeHandle.replace(/^@/, '').toLowerCase();
      if (desc.includes('youtube.com/@' + handle)) return true;
      if (desc.includes('@' + handle)) return true;
    }

    return false;
  }

  private mapToCandidate(item: SepiaChannelResult & { host?: string }): ChannelCandidate {
    let avatarUrl: string | undefined;
    if (item.avatars && item.avatars.length > 0) {
      const avatar = item.avatars[item.avatars.length - 1]; // largest
      const host = item.host || new URL(item.url).host;
      avatarUrl = avatar.path.startsWith('http') ? avatar.path : `https://${host}${avatar.path}`;
    }

    return {
      url: item.url,
      handle: item.name,
      displayName: item.displayName,
      avatarUrl,
      subscriberCount: item.followersCount,
      description: item.description ?? undefined,
      platform: 'peertube',
    };
  }
}
