import { createHash } from 'crypto';
import type { PluginConfig } from '../types.js';

const ALLOWED_URLS = new Set([
  'https://plugins.grayjay.app/Bitchute/BitchuteConfig.json',
  'https://plugins.grayjay.app/Rumble/RumbleConfig.json',
  'https://plugins.grayjay.app/Dailymotion/DailymotionConfig.json',
]);

export function isPluginUrlAllowed(url: string): boolean {
  return ALLOWED_URLS.has(url);
}

export function verifyPluginHash(scriptSource: string, expectedHash: string): boolean {
  const hash = createHash('sha256').update(scriptSource).digest('hex');
  return hash === expectedHash;
}

export function computePluginHash(scriptSource: string): string {
  return createHash('sha256').update(scriptSource).digest('hex');
}

export interface PluginUpdateCheck {
  name: string;
  sourceUrl: string;
  currentHash: string;
  currentVersion: number;
  newHash?: string;
  newVersion?: number;
  hasUpdate: boolean;
}

/**
 * Check if a plugin has an update available.
 * Does NOT auto-update — just reports.
 */
export async function checkForPluginUpdate(config: PluginConfig): Promise<PluginUpdateCheck> {
  const result: PluginUpdateCheck = {
    name: config.name,
    sourceUrl: config.sourceUrl,
    currentHash: config.contentHash,
    currentVersion: config.version,
    hasUpdate: false,
  };

  try {
    const resp = await fetch(config.sourceUrl);
    if (!resp.ok) return result;

    const remoteConfig = await resp.json();
    result.newVersion = remoteConfig.version;

    const scriptUrl = new URL(remoteConfig.scriptUrl, config.sourceUrl).toString();
    const scriptResp = await fetch(scriptUrl);
    if (!scriptResp.ok) return result;

    const scriptSource = await scriptResp.text();
    result.newHash = computePluginHash(scriptSource);

    if (result.newHash !== config.contentHash || remoteConfig.version !== config.version) {
      result.hasUpdate = true;
    }
  } catch {
    // Can't reach plugin source — no update info
  }

  return result;
}
