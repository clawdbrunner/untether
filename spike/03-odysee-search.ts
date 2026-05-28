/**
 * Spike 3: Odysee/LBRY Search
 * Validates Odysee/LBRY channel resolution and search APIs.
 */

import { writeFileSync } from 'fs';
import { join } from 'path';

const RESULTS_DIR = join(import.meta.dirname, 'results');

const HEADERS = {
  'User-Agent': 'Untether/0.1 (spike-validation)',
  'Accept': 'application/json',
  'Content-Type': 'application/json',
};

const TEST_QUERIES = [
  'Linus Tech Tips',
  'The Linux Experiment',
  'Marques Brownlee',
  'Veritasium',
  'Fireship',
];

interface OdyseeResult {
  query: string;
  method: string;
  status: 'SUCCESS' | 'ERROR';
  total: number;
  topResults: Array<{
    name: string;
    claimId?: string;
    url?: string;
    title?: string;
    description?: string;
    thumbnailUrl?: string;
  }>;
  rateLimitHeaders: Record<string, string>;
  responseTimeMs: number;
  error?: string;
  rawResponseShape?: string[];
}

function extractRateLimitHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of headers.entries()) {
    if (key.toLowerCase().includes('rate') || key.toLowerCase().includes('limit') || key.toLowerCase().includes('retry')) {
      result[key] = val;
    }
  }
  return result;
}

async function lighthouseSearch(query: string): Promise<OdyseeResult> {
  const url = `https://lighthouse.odysee.com/search?s=${encodeURIComponent(query)}&size=5&claimType=channel`;
  const start = Date.now();

  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': HEADERS['User-Agent'], 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    const elapsed = Date.now() - start;
    const rateLimitHeaders = extractRateLimitHeaders(resp.headers);

    if (!resp.ok) {
      return { query, method: 'lighthouse', status: 'ERROR', total: 0, topResults: [], rateLimitHeaders, responseTimeMs: elapsed, error: `HTTP ${resp.status}` };
    }

    const data = await resp.json();
    const items = Array.isArray(data) ? data : [];

    const topResults = items.slice(0, 5).map((item: any) => ({
      name: item.name || '',
      claimId: item.claimId || item.claim_id || '',
      title: item.title || '',
      description: item.description?.substring(0, 100) || undefined,
      thumbnailUrl: item.thumbnail_url || undefined,
    }));

    return {
      query,
      method: 'lighthouse',
      status: 'SUCCESS',
      total: items.length,
      topResults,
      rateLimitHeaders,
      responseTimeMs: elapsed,
      rawResponseShape: items.length > 0 ? Object.keys(items[0]) : [],
    };
  } catch (e: any) {
    return { query, method: 'lighthouse', status: 'ERROR', total: 0, topResults: [], rateLimitHeaders: {}, responseTimeMs: Date.now() - start, error: e.message };
  }
}

async function claimSearch(query: string): Promise<OdyseeResult> {
  const url = 'https://api.na-backend.odysee.com/api/v1/proxy?m=claim_search';
  const start = Date.now();

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: HEADERS,
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'claim_search',
        params: {
          text: query,
          claim_type: ['channel'],
          page_size: 5,
          order_by: ['effective_amount'],
        },
      }),
    });
    const elapsed = Date.now() - start;
    const rateLimitHeaders = extractRateLimitHeaders(resp.headers);

    if (!resp.ok) {
      return { query, method: 'claim_search', status: 'ERROR', total: 0, topResults: [], rateLimitHeaders, responseTimeMs: elapsed, error: `HTTP ${resp.status}` };
    }

    const data = await resp.json();
    if (data.error) {
      return { query, method: 'claim_search', status: 'ERROR', total: 0, topResults: [], rateLimitHeaders, responseTimeMs: elapsed, error: JSON.stringify(data.error) };
    }

    const items = data.result?.items || [];
    const topResults = items.slice(0, 5).map((item: any) => ({
      name: item.name || '',
      claimId: item.claim_id || '',
      url: item.permanent_url || item.canonical_url || '',
      title: item.value?.title || '',
      description: item.value?.description?.substring(0, 100) || undefined,
      thumbnailUrl: item.value?.thumbnail?.url || undefined,
    }));

    return {
      query,
      method: 'claim_search',
      status: 'SUCCESS',
      total: data.result?.total_items ?? items.length,
      topResults,
      rateLimitHeaders,
      responseTimeMs: elapsed,
      rawResponseShape: items.length > 0 ? Object.keys(items[0]) : [],
    };
  } catch (e: any) {
    return { query, method: 'claim_search', status: 'ERROR', total: 0, topResults: [], rateLimitHeaders: {}, responseTimeMs: Date.now() - start, error: e.message };
  }
}

async function resolveChannel(name: string): Promise<OdyseeResult> {
  const url = 'https://api.na-backend.odysee.com/api/v1/proxy?m=resolve';
  const start = Date.now();

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: HEADERS,
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'resolve',
        params: { urls: [`lbry://${name}`] },
      }),
    });
    const elapsed = Date.now() - start;
    const rateLimitHeaders = extractRateLimitHeaders(resp.headers);

    if (!resp.ok) {
      return { query: name, method: 'resolve', status: 'ERROR', total: 0, topResults: [], rateLimitHeaders, responseTimeMs: elapsed, error: `HTTP ${resp.status}` };
    }

    const data = await resp.json();
    if (data.error) {
      return { query: name, method: 'resolve', status: 'ERROR', total: 0, topResults: [], rateLimitHeaders, responseTimeMs: elapsed, error: JSON.stringify(data.error) };
    }

    const results = data.result || {};
    const entries = Object.values(results) as any[];
    const resolved = entries.filter((e: any) => !e.error);

    const topResults = resolved.map((item: any) => ({
      name: item.name || '',
      claimId: item.claim_id || '',
      url: item.permanent_url || item.canonical_url || '',
      title: item.value?.title || '',
      description: item.value?.description?.substring(0, 100) || undefined,
      thumbnailUrl: item.value?.thumbnail?.url || undefined,
    }));

    return {
      query: name,
      method: 'resolve',
      status: resolved.length > 0 ? 'SUCCESS' : 'ERROR',
      total: resolved.length,
      topResults,
      rateLimitHeaders,
      responseTimeMs: elapsed,
      error: resolved.length === 0 ? 'Channel not found' : undefined,
    };
  } catch (e: any) {
    return { query: name, method: 'resolve', status: 'ERROR', total: 0, topResults: [], rateLimitHeaders: {}, responseTimeMs: Date.now() - start, error: e.message };
  }
}

export async function runSpike3(): Promise<void> {
  console.log('\n=== Spike 3: Odysee/LBRY Search ===');
  const allResults: OdyseeResult[] = [];

  // Lighthouse search
  console.log('\n--- Lighthouse Search API ---');
  for (const query of TEST_QUERIES) {
    const result = await lighthouseSearch(query);
    allResults.push(result);

    const top = result.topResults[0];
    console.log(`  "${query}": ${result.status === 'SUCCESS' ? `${result.total} results` : `ERROR: ${result.error}`}${
      top ? `, top: "${top.name}" (${top.title || 'no title'})` : ''
    } [${result.responseTimeMs}ms]`);
  }

  // Claim search (LBRY API)
  console.log('\n--- LBRY claim_search API ---');
  for (const query of TEST_QUERIES) {
    const result = await claimSearch(query);
    allResults.push(result);

    const top = result.topResults[0];
    console.log(`  "${query}": ${result.status === 'SUCCESS' ? `${result.total} results` : `ERROR: ${result.error}`}${
      top ? `, top: "${top.name}" (${top.title || 'no title'})` : ''
    } [${result.responseTimeMs}ms]`);
  }

  // Direct resolve
  console.log('\n--- Direct Resolve ---');
  const resolveNames = ['@linustechtips', '@TheLinuxExperiment', '@veritasium'];
  for (const name of resolveNames) {
    const result = await resolveChannel(name);
    allResults.push(result);
    console.log(`  ${name}: ${result.status} [${result.responseTimeMs}ms]${result.error ? ` (${result.error})` : ''}`);
  }

  // Response shape
  const successWithShape = allResults.find(r => r.rawResponseShape && r.rawResponseShape.length > 0);
  if (successWithShape) {
    console.log(`\n--- Response Shape (${successWithShape.method}) ---`);
    console.log(`  Fields: ${JSON.stringify(successWithShape.rawResponseShape)}`);
  }

  // Rate limits
  const withRateLimits = allResults.find(r => Object.keys(r.rateLimitHeaders).length > 0);
  if (withRateLimits) {
    console.log(`\n--- Rate Limit Headers ---`);
    console.log(`  ${JSON.stringify(withRateLimits.rateLimitHeaders)}`);
  } else {
    console.log(`\n--- Rate Limit Headers ---`);
    console.log(`  No rate limit headers detected`);
  }

  // Summary
  const lighthouseResults = allResults.filter(r => r.method === 'lighthouse');
  const claimResults = allResults.filter(r => r.method === 'claim_search');
  const resolveResults = allResults.filter(r => r.method === 'resolve');

  console.log(`\n--- Summary ---`);
  console.log(`  Lighthouse: ${lighthouseResults.filter(r => r.status === 'SUCCESS').length}/${lighthouseResults.length} succeeded`);
  console.log(`  claim_search: ${claimResults.filter(r => r.status === 'SUCCESS').length}/${claimResults.length} succeeded`);
  console.log(`  resolve: ${resolveResults.filter(r => r.status === 'SUCCESS').length}/${resolveResults.length} succeeded`);

  writeFileSync(join(RESULTS_DIR, 'odysee-search-responses.json'), JSON.stringify(allResults, null, 2));
  console.log(`  Results saved to spike/results/odysee-search-responses.json`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('03-odysee-search.ts')) {
  runSpike3();
}
