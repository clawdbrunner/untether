import { createHash } from 'crypto';
import type { PluginConfig } from '../types.js';
import type { ResourceCache } from '../cache/resource-cache.js';
import { isPluginUrlAllowed } from './trust.js';

export class PluginLoader {
  constructor(private cache: ResourceCache) {}

  /**
   * Load a plugin: fetch script, verify hash, cache it.
   * Returns the script source string.
   */
  async load(config: PluginConfig): Promise<string> {
    // Validate URL against allowlist
    if (!isPluginUrlAllowed(config.sourceUrl)) {
      throw new Error(`Plugin URL not in allowlist: ${config.sourceUrl}`);
    }

    // Check cache first
    const cached = await this.cache.getPluginScript(config.contentHash);
    if (cached) return cached;

    // Fetch the script
    const resp = await fetch(config.scriptUrl, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) throw new Error(`Failed to fetch plugin script: ${resp.status}`);
    const script = await resp.text();

    // Verify content hash
    const hash = createHash('sha256').update(script).digest('hex');
    if (hash !== config.contentHash) {
      throw new Error(`Plugin hash mismatch for ${config.name}: expected ${config.contentHash}, got ${hash}`);
    }

    // Cache it
    await this.cache.setPluginScript(config.contentHash, script);
    return script;
  }
}
