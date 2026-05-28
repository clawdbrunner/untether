import type { DeclaredLink } from '../types.js';
import { getRegistry } from '../platform-registry.js';

const LBRY_PROTOCOL_RE = /lbry:\/\/@[^)\s<>"']+/gi;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

export function parseDescriptionLinks(description: string): DeclaredLink[] {
  if (!description) return [];

  const registry = getRegistry();
  const links: DeclaredLink[] = [];
  const seen = new Set<string>();

  function addLink(platform: DeclaredLink['platform'], url: string) {
    const normalized = url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    links.push({ platform, url, source: 'description' });
  }

  // Extract all URLs and classify via registry
  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_RE.exec(description)) !== null) {
    let rawUrl = match[0];
    // Clean trailing punctuation
    rawUrl = rawUrl.replace(/[.,;:!?)\]}>]+$/, '');

    const platform = registry.classifyForMatch(rawUrl);
    if (platform) {
      addLink(platform, rawUrl);
      continue;
    }

    // LBRY TV fallback (lbry.tv is defunct, not in registry)
    const lower = rawUrl.toLowerCase();
    if (lower.includes('lbry.tv/@')) {
      addLink('lbry', rawUrl);
    }
  }

  // LBRY protocol URIs (not HTTP URLs)
  LBRY_PROTOCOL_RE.lastIndex = 0;
  while ((match = LBRY_PROTOCOL_RE.exec(description)) !== null) {
    addLink('lbry', match[0]);
  }

  return links;
}
