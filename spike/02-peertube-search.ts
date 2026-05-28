/**
 * Spike 2: PeerTube Search
 * Validates PeerTube Sepia search API response shape and reliability.
 */

import { writeFileSync } from 'fs';
import { join } from 'path';

const RESULTS_DIR = join(import.meta.dirname, 'results');

const HEADERS = {
  'User-Agent': 'Untether/0.1 (spike-validation)',
  'Accept': 'application/json',
};

const SEPIA_BASE = 'https://search.joinpeertube.org/api/v1/search/video-channels';
const FRAMATUBE_BASE = 'https://framatube.org/api/v1/search/video-channels';

const TEST_QUERIES = [
  'Linus Tech Tips',
  'The Linux Experiment',
  'Marques Brownlee',
  'Veritasium',
  'Fireship',
];

interface SearchResult {
  query: string;
  endpoint: string;
  status: 'SUCCESS' | 'ERROR';
  total: number;
  topResults: Array<{
    displayName: string;
    name: string;
    url: string;
    host: string;
    followersCount: number;
    description?: string;
  }>;
  rateLimitHeaders: Record<string, string>;
  responseTimeMs: number;
  error?: string;
}

async function searchPeerTube(query: string, baseUrl: string): Promise<SearchResult> {
  const url = `${baseUrl}?q=${encodeURIComponent(query)}&count=5`;
  const start = Date.now();

  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
    const elapsed = Date.now() - start;

    // Capture rate limit headers
    const rateLimitHeaders: Record<string, string> = {};
    for (const [key, val] of resp.headers.entries()) {
      if (key.toLowerCase().includes('rate') || key.toLowerCase().includes('limit') || key.toLowerCase().includes('retry')) {
        rateLimitHeaders[key] = val;
      }
    }

    if (!resp.ok) {
      return {
        query,
        endpoint: baseUrl,
        status: 'ERROR',
        total: 0,
        topResults: [],
        rateLimitHeaders,
        responseTimeMs: elapsed,
        error: `HTTP ${resp.status}: ${resp.statusText}`,
      };
    }

    const data = await resp.json();

    const topResults = (data.data || []).slice(0, 5).map((ch: any) => ({
      displayName: ch.displayName || '',
      name: ch.name || '',
      url: ch.url || '',
      host: ch.host || '',
      followersCount: ch.followersCount ?? 0,
      description: ch.description?.substring(0, 100) || undefined,
    }));

    return {
      query,
      endpoint: baseUrl,
      status: 'SUCCESS',
      total: data.total ?? 0,
      topResults,
      rateLimitHeaders,
      responseTimeMs: elapsed,
    };
  } catch (e: any) {
    return {
      query,
      endpoint: baseUrl,
      status: 'ERROR',
      total: 0,
      topResults: [],
      rateLimitHeaders: {},
      responseTimeMs: Date.now() - start,
      error: e.message,
    };
  }
}

export async function runSpike2(): Promise<void> {
  console.log('\n=== Spike 2: PeerTube Search API ===');

  const allResults: SearchResult[] = [];

  // Test Sepia search index
  console.log('\n--- Sepia Search Index (search.joinpeertube.org) ---');
  for (const query of TEST_QUERIES) {
    const result = await searchPeerTube(query, SEPIA_BASE);
    allResults.push(result);

    const topMatch = result.topResults[0];
    console.log(`  "${query}": ${result.status === 'SUCCESS' ? `${result.total} results` : `ERROR: ${result.error}`}${
      topMatch ? `, top: "${topMatch.displayName}@${topMatch.host}" (${topMatch.followersCount} followers)` : ''
    } [${result.responseTimeMs}ms]`);
  }

  // Test Framatube direct instance
  console.log('\n--- Framatube Direct Instance ---');
  const framaResult = await searchPeerTube('Linus Tech Tips', FRAMATUBE_BASE);
  allResults.push(framaResult);
  console.log(`  "Linus Tech Tips": ${framaResult.status === 'SUCCESS' ? `${framaResult.total} results` : `ERROR: ${framaResult.error}`} [${framaResult.responseTimeMs}ms]`);

  // Document response shape
  const successResults = allResults.filter(r => r.status === 'SUCCESS' && r.topResults.length > 0);
  if (successResults.length > 0) {
    const sample = successResults[0].topResults[0];
    console.log(`\n--- Response Shape ---`);
    console.log(`  ChannelResult fields: ${JSON.stringify(Object.keys(sample))}`);
  }

  // Rate limit info
  const headersWithRateLimit = allResults.find(r => Object.keys(r.rateLimitHeaders).length > 0);
  if (headersWithRateLimit) {
    console.log(`\n--- Rate Limit Headers ---`);
    console.log(`  ${JSON.stringify(headersWithRateLimit.rateLimitHeaders)}`);
  } else {
    console.log(`\n--- Rate Limit Headers ---`);
    console.log(`  No rate limit headers detected in responses`);
  }

  // Summary
  const sepiaResults = allResults.filter(r => r.endpoint === SEPIA_BASE);
  const sepiaSuccess = sepiaResults.filter(r => r.status === 'SUCCESS').length;
  console.log(`\n--- Summary ---`);
  console.log(`  Sepia: ${sepiaSuccess}/${sepiaResults.length} queries succeeded`);
  console.log(`  Framatube: ${framaResult.status}`);
  console.log(`  Avg response time: ${Math.round(allResults.reduce((s, r) => s + r.responseTimeMs, 0) / allResults.length)}ms`);

  writeFileSync(join(RESULTS_DIR, 'peertube-search-responses.json'), JSON.stringify(allResults, null, 2));
  console.log(`  Results saved to spike/results/peertube-search-responses.json`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('02-peertube-search.ts')) {
  runSpike2();
}
