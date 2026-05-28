/**
 * Spike 1: YouTube About-Page Parser
 * Validates extraction of ytInitialData.links[] from YouTube channel /about pages.
 */

import { writeFileSync } from 'fs';
import { join } from 'path';

const RESULTS_DIR = join(import.meta.dirname, 'results');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const TEST_CHANNELS = ['@LinusTechTips', '@pocketverything', '@TheLinuxEXP'];

interface ChannelLink {
  title: string;
  url: string;
}

interface ChannelResult {
  channel: string;
  status: 'SUCCESS' | 'BLOCKED' | 'PARTIAL' | 'ERROR';
  links: ChannelLink[];
  formalAltPlatformLinks: ChannelLink[];
  error?: string;
  rawHtmlSnippet?: string;
}

function decodeRedirectUrl(url: string): string {
  try {
    const u = new URL(url, 'https://www.youtube.com');
    if (u.pathname === '/redirect' && u.searchParams.has('q')) {
      return u.searchParams.get('q')!;
    }
  } catch {}
  return url;
}

/** Recursively search for a key in a nested object */
function deepFind(obj: any, targetKey: string): any[] {
  const results: any[] = [];
  if (!obj || typeof obj !== 'object') return results;

  if (targetKey in obj) {
    results.push(obj[targetKey]);
  }

  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      results.push(...deepFind(val, targetKey));
    }
  }
  return results;
}

function extractLinks(ytInitialData: any): ChannelLink[] {
  const links: ChannelLink[] = [];

  // Try channelAboutFullMetadataRenderer.links (older format)
  const aboutFull = deepFind(ytInitialData, 'channelAboutFullMetadataRenderer');
  for (const renderer of aboutFull) {
    if (renderer?.links) {
      for (const link of renderer.links) {
        const run = link?.channelExternalLinkViewModel;
        if (run) {
          const title = run.title?.content || run.title || 'Unknown';
          const rawUrl = run.link?.commandRuns?.[0]?.onTap?.innertubeCommand?.urlEndpoint?.url
            || run.link?.content || '';
          if (rawUrl) {
            links.push({ title, url: decodeRedirectUrl(rawUrl) });
          }
        }
      }
    }
    // Also check primaryLinks
    if (renderer?.primaryLinks) {
      for (const link of renderer.primaryLinks) {
        const title = link?.title?.simpleText || 'Unknown';
        const rawUrl = link?.navigationEndpoint?.urlEndpoint?.url || '';
        if (rawUrl) {
          links.push({ title, url: decodeRedirectUrl(rawUrl) });
        }
      }
    }
  }

  // Try aboutChannelViewModel (newer format)
  const aboutViewModel = deepFind(ytInitialData, 'aboutChannelViewModel');
  for (const vm of aboutViewModel) {
    if (vm?.links) {
      for (const link of vm.links) {
        const cLink = link?.channelExternalLinkViewModel;
        if (cLink) {
          const title = cLink.title?.content || cLink.title || 'Unknown';
          const rawUrl = cLink.link?.commandRuns?.[0]?.onTap?.innertubeCommand?.urlEndpoint?.url
            || cLink.link?.content || '';
          if (rawUrl) {
            links.push({ title, url: decodeRedirectUrl(rawUrl) });
          }
        }
      }
    }
  }

  // Dedupe by URL
  const seen = new Set<string>();
  return links.filter(l => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  });
}

function isAltPlatformLink(link: ChannelLink): boolean {
  const url = link.url.toLowerCase();
  const title = link.title.toLowerCase();
  return (
    url.includes('peertube') || url.includes('odysee') || url.includes('lbry') ||
    url.includes('nebula') || url.includes('floatplane') || url.includes('rumble') ||
    title.includes('peertube') || title.includes('odysee') || title.includes('lbry') ||
    title.includes('nebula') || title.includes('floatplane') || title.includes('rumble')
  );
}

async function parseChannel(handle: string): Promise<ChannelResult> {
  const url = `https://www.youtube.com/${handle}/about`;

  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
    const html = await resp.text();

    // Check for bot detection / consent page
    if (html.includes('consent.youtube.com') || html.includes('consent.google.com')) {
      return { channel: handle, status: 'BLOCKED', links: [], formalAltPlatformLinks: [], error: 'Consent/cookie wall detected', rawHtmlSnippet: html.substring(0, 500) };
    }

    // Extract ytInitialData
    const match = html.match(/var\s+ytInitialData\s*=\s*({.+?});\s*<\/script>/s);
    if (!match) {
      // Try alternative pattern
      const alt = html.match(/ytInitialData\s*=\s*'(.+?)';\s*<\/script>/s);
      if (!alt) {
        const hasScript = html.includes('ytInitialData');
        return {
          channel: handle,
          status: hasScript ? 'PARTIAL' : 'BLOCKED',
          links: [],
          formalAltPlatformLinks: [],
          error: hasScript ? 'ytInitialData found but could not extract JSON' : 'No ytInitialData in response (likely bot detection)',
          rawHtmlSnippet: html.substring(0, 500),
        };
      }
    }

    let ytInitialData: any;
    try {
      ytInitialData = JSON.parse(match![1]);
    } catch (e) {
      return { channel: handle, status: 'PARTIAL', links: [], formalAltPlatformLinks: [], error: `JSON parse error: ${e}` };
    }

    const links = extractLinks(ytInitialData);
    const formalAltPlatformLinks = links.filter(isAltPlatformLink);

    return {
      channel: handle,
      status: links.length > 0 ? 'SUCCESS' : 'PARTIAL',
      links,
      formalAltPlatformLinks,
    };
  } catch (e: any) {
    return { channel: handle, status: 'ERROR', links: [], formalAltPlatformLinks: [], error: e.message };
  }
}

export async function runSpike1(): Promise<void> {
  console.log('\n=== Spike 1: YouTube About-Page Parser ===');
  const results: ChannelResult[] = [];

  for (const channel of TEST_CHANNELS) {
    const result = await parseChannel(channel);
    results.push(result);

    console.log(`\nChannel: ${channel}`);
    console.log(`  Status: ${result.status}`);
    if (result.error) console.log(`  Error: ${result.error}`);
    console.log(`  Links found: ${result.links.length}`);
    if (result.links.length > 0) {
      console.log(`  Links: ${JSON.stringify(result.links, null, 2)}`);
    }
    console.log(`  Alt-platform links (peertube/odysee/lbry/etc): ${result.formalAltPlatformLinks.length}`);
    if (result.formalAltPlatformLinks.length > 0) {
      console.log(`  Alt-platform: ${JSON.stringify(result.formalAltPlatformLinks, null, 2)}`);
    }
  }

  const successCount = results.filter(r => r.status === 'SUCCESS').length;
  const blockedCount = results.filter(r => r.status === 'BLOCKED').length;

  console.log(`\n--- Summary ---`);
  console.log(`  ${successCount}/${results.length} succeeded`);
  console.log(`  ${blockedCount}/${results.length} blocked by bot detection`);
  if (blockedCount > 0) {
    console.log(`  ⚠️  YouTube bot detection active — yt-dlp fallback may be needed`);
  }

  writeFileSync(join(RESULTS_DIR, 'yt-about-links.json'), JSON.stringify(results, null, 2));
  console.log(`  Results saved to spike/results/yt-about-links.json`);
}

// Allow direct execution
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('01-yt-about-parser.ts')) {
  runSpike1();
}
