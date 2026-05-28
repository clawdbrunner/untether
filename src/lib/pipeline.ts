import { join } from 'path';
import type {
  PipelineConfig,
  PipelineResult,
  MatchResult,
  YouTubeChannel,
  DeclaredLink,
  ProgressEvent,
} from './types.js';
import { ResourceCache } from './cache/resource-cache.js';
import { RateLimiter } from './rate-limit/rate-limiter.js';
import { parseTakeoutCsv } from './ingest/takeout-parser.js';
import { enrichChannels } from './enrichment/enricher.js';
import { extractDeclaredLinks } from './links/link-extractor.js';
import { PeerTubeAdapter } from './adapters/peertube.js';
import { OdyseeAdapter } from './adapters/odysee.js';
import type { PlatformAdapter } from './adapters/adapter-interface.js';
import { matchChannel } from './matching/matcher.js';

export async function runPipeline(
  csvText: string,
  config: PipelineConfig,
): Promise<PipelineResult> {
  const cache = new ResourceCache(join(process.cwd(), '.cache', 'untether'));
  const limiter = new RateLimiter();

  const report = (phase: ProgressEvent['phase'], current: number, total: number, message: string) => {
    config.onProgress?.({ phase, current, total, message });
  };

  // Phase 1: Ingest
  const channels = parseTakeoutCsv(csvText);
  report('ingest', channels.length, channels.length, `Parsed ${channels.length} channels from CSV`);

  if (channels.length === 0) {
    return emptyResult(channels);
  }

  // Phase 2: Enrich
  report('enrich', 0, channels.length, 'Starting enrichment...');
  await enrichChannels(channels, config, cache, limiter);
  const enriched = channels.filter((c) => c.description).length;
  report('enrich', channels.length, channels.length, `Enriched ${enriched}/${channels.length} channels`);

  // Phase 3: Extract declared links
  const linksMap = new Map<string, DeclaredLink[]>();
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    const links = await extractDeclaredLinks(ch, cache, limiter);
    linksMap.set(ch.id, links);
    report('links', i + 1, channels.length, `Extracted links for ${ch.title}`);
  }

  const totalDeclaredLinks = Array.from(linksMap.values()).reduce((sum, links) => sum + links.length, 0);
  report('links', channels.length, channels.length, `Found ${totalDeclaredLinks} declared links`);

  // Phase 4: Match
  const adapters = createAdapters(config, cache, limiter);
  const matches: MatchResult[] = [];
  const totalWork = channels.length * config.platforms.length;
  let completed = 0;

  for (const platform of config.platforms) {
    const adapter = adapters.get(platform);
    if (!adapter) continue;

    for (const ch of channels) {
      try {
        const result = await matchChannel(
          ch,
          platform,
          adapter,
          linksMap.get(ch.id) || [],
          cache,
          limiter,
        );
        matches.push(result);
      } catch (err) {
        if (err instanceof Error && err.message.includes('Circuit breaker open')) {
          process.stderr.write(`[pipeline] Skipping ${platform} — circuit breaker open\n`);
          matches.push({ youtubeChannel: ch, platform, candidates: [] });
        } else {
          throw err;
        }
      }
      completed++;
      report('match', completed, totalWork, `Matched ${ch.title} on ${platform}`);
    }
  }

  return buildResult(channels, matches, enriched, totalDeclaredLinks);
}

function createAdapters(
  config: PipelineConfig,
  cache: ResourceCache,
  limiter: RateLimiter,
): Map<string, PlatformAdapter> {
  const adapters = new Map<string, PlatformAdapter>();

  if (config.platforms.includes('peertube')) {
    adapters.set('peertube', new PeerTubeAdapter(
      config.peertubeInstances || ['search.joinpeertube.org'],
      cache,
      limiter,
    ));
  }

  if (config.platforms.includes('odysee')) {
    adapters.set('odysee', new OdyseeAdapter(cache, limiter));
  }

  return adapters;
}

function buildResult(
  channels: YouTubeChannel[],
  matches: MatchResult[],
  enriched: number,
  declaredLinksFound: number,
): PipelineResult {
  let verified = 0, likely = 0, possible = 0, weak = 0;

  for (const match of matches) {
    const top = match.candidates[0];
    if (!top) continue;
    switch (top.tier) {
      case 'verified': verified++; break;
      case 'likely': likely++; break;
      case 'possible': possible++; break;
      case 'weak': weak++; break;
    }
  }

  return {
    channels,
    matches,
    stats: {
      totalChannels: channels.length,
      enriched,
      enrichmentFailed: channels.length - enriched,
      declaredLinksFound,
      verifiedMatches: verified,
      likelyMatches: likely,
      possibleMatches: possible,
      weakMatches: weak,
    },
  };
}

function emptyResult(channels: YouTubeChannel[]): PipelineResult {
  return {
    channels,
    matches: [],
    stats: {
      totalChannels: 0,
      enriched: 0,
      enrichmentFailed: 0,
      declaredLinksFound: 0,
      verifiedMatches: 0,
      likelyMatches: 0,
      possibleMatches: 0,
      weakMatches: 0,
    },
  };
}
