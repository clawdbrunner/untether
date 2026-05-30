import type { ChannelCandidate } from '../types.js';
import type { PlatformAdapter } from './adapter-interface.js';
import type { ResourceCache } from '../cache/resource-cache.js';
import type { RateLimiter } from '../rate-limit/rate-limiter.js';

interface LighthouseResult {
  name: string;
  claimId: string;
  channel_claim_id?: string;
}

interface LbryResolveResult {
  value?: {
    title?: string;
    description?: string;
    thumbnail?: { url?: string };
  };
  meta?: {
    effective_amount?: string;
  };
  short_url?: string;
  permanent_url?: string;
  name?: string;
}

const ODYSEE_URL_RE = /^https?:\/\/odysee\.com\/@([^/?#:]+)/i;

export class OdyseeAdapter implements PlatformAdapter {
  readonly id = 'odysee' as const;

  constructor(
    private cache: ResourceCache,
    private limiter: RateLimiter,
  ) {}

  async searchChannels(query: string): Promise<ChannelCandidate[]> {
    // Check cache
    const cached = await this.cache.getSearchResults('odysee', query);
    if (cached) return cached;

    const release = await this.limiter.acquire('odysee');
    try {
      // Use Lighthouse for channel search
      const url = `https://lighthouse.odysee.com/search?s=${encodeURIComponent(query)}&size=10&claimType=channel`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) {
        this.limiter.reportFailure('odysee');
        return [];
      }

      this.limiter.reportSuccess('odysee');
      const results: LighthouseResult[] = await resp.json();

      // Resolve each result for full metadata
      const candidates: ChannelCandidate[] = [];
      for (const result of results) {
        const resolved = await this.resolveByName(result.name);
        if (resolved) candidates.push(resolved);
      }

      if (candidates.length > 0) await this.cache.setSearchResults('odysee', query, candidates);
      return candidates;
    } catch {
      this.limiter.reportFailure('odysee');
      return [];
    } finally {
      release();
    }
  }

  async resolveChannel(url: string): Promise<ChannelCandidate | null> {
    const match = url.match(ODYSEE_URL_RE);
    if (!match) return null;

    const handle = match[1];
    return this.resolveByName(`@${handle}`);
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
    }

    return false;
  }

  private async resolveByName(name: string): Promise<ChannelCandidate | null> {
    const lbryUrl = name.startsWith('lbry://') ? name : `lbry://${name}`;

    try {
      const resp = await fetch('https://api.na-backend.odysee.com/api/v1/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'resolve',
          params: { urls: [lbryUrl] },
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) {
        this.limiter.reportFailure('odysee');
        return null;
      }

      this.limiter.reportSuccess('odysee');
      const data = await resp.json();
      const results = data.result as Record<string, LbryResolveResult> | undefined;
      if (!results) return null;

      const resolved = Object.values(results)[0];
      if (!resolved || !resolved.value) return null;

      const handle = resolved.name || name.replace(/^lbry:\/\//, '').replace(/^@/, '');

      return {
        url: `https://odysee.com/${name.startsWith('@') ? name : '@' + handle}`,
        handle: handle.replace(/^@/, ''),
        displayName: resolved.value.title || handle,
        avatarUrl: resolved.value.thumbnail?.url,
        description: resolved.value.description,
        platform: 'odysee',
      };
    } catch {
      this.limiter.reportFailure('odysee');
      return null;
    }
  }
}
