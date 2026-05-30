import type { ChannelCandidate } from '../types.js';
import type { PlatformAdapter } from './adapter-interface.js';
import type { ResourceCache } from '../cache/resource-cache.js';
import type { RateLimiter } from '../rate-limit/rate-limiter.js';

const DM_API = 'https://api.dailymotion.com';
const DM_FIELDS = 'id,username,screenname,avatar_360_url,description,followers_total';
const DM_URL_RE = /^https?:\/\/(?:www\.)?dailymotion\.com\/([^/?#]+)/i;

interface DmUser {
  id: string;
  username: string;
  screenname: string;
  avatar_360_url: string;
  description: string;
  followers_total: number;
}

interface DmSearchResponse {
  total: number;
  has_more: boolean;
  list: DmUser[];
}

export class DailymotionAdapter implements PlatformAdapter {
  readonly id = 'dailymotion' as const;

  constructor(
    private cache: ResourceCache,
    private limiter: RateLimiter,
  ) {}

  async searchChannels(query: string): Promise<ChannelCandidate[]> {
    // Check cache
    const cached = await this.cache.getSearchResults('dailymotion', query);
    if (cached) return cached;

    const release = await this.limiter.acquire('dailymotion');
    try {
      const url = `${DM_API}/users?search=${encodeURIComponent(query)}&fields=${DM_FIELDS}&limit=10`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });

      if (!resp.ok) {
        this.limiter.reportFailure('dailymotion');
        return [];
      }
      this.limiter.reportSuccess('dailymotion');

      const data: DmSearchResponse = await resp.json();
      const candidates = (data.list || []).map(u => this.mapToCandidate(u));

      await this.cache.setSearchResults('dailymotion', query, candidates);
      return candidates;
    } catch {
      this.limiter.reportFailure('dailymotion');
      return [];
    } finally {
      release();
    }
  }

  async resolveChannel(url: string): Promise<ChannelCandidate | null> {
    const match = url.match(DM_URL_RE);
    if (!match) return null;

    const username = match[1];
    // Skip non-channel paths (video, playlist, etc.)
    if (['video', 'playlist', 'feed', 'login', 'register', 'password', 'upload'].includes(username.toLowerCase())) {
      return null;
    }

    const release = await this.limiter.acquire('dailymotion');
    try {
      const apiUrl = `${DM_API}/user/${encodeURIComponent(username)}?fields=${DM_FIELDS}`;
      const resp = await fetch(apiUrl, { signal: AbortSignal.timeout(30_000) });

      if (!resp.ok) {
        if (resp.status !== 404) this.limiter.reportFailure('dailymotion');
        return null;
      }
      this.limiter.reportSuccess('dailymotion');

      const data: DmUser = await resp.json();
      return this.mapToCandidate(data);
    } catch {
      this.limiter.reportFailure('dailymotion');
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

    if (desc.includes(youtubeChannelId.toLowerCase())) return true;
    if (desc.includes('youtube.com/channel/' + youtubeChannelId.toLowerCase())) return true;

    if (youtubeHandle) {
      const handle = youtubeHandle.replace(/^@/, '').toLowerCase();
      if (desc.includes('youtube.com/@' + handle)) return true;
      if (desc.includes('@' + handle)) return true;
    }

    return false;
  }

  private mapToCandidate(user: DmUser): ChannelCandidate {
    return {
      url: `https://www.dailymotion.com/${user.username}`,
      handle: user.username,
      displayName: user.screenname || user.username,
      avatarUrl: user.avatar_360_url || undefined,
      subscriberCount: user.followers_total || undefined,
      description: user.description || undefined,
      platform: 'dailymotion',
    };
  }
}
