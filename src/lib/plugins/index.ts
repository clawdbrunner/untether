import type { PluginConfig } from '../types.js';
import type { RateLimiter } from '../rate-limit/rate-limiter.js';
import type { ResourceCache } from '../cache/resource-cache.js';
import { GrayjayPluginAdapter } from './grayjay-adapter.js';
import { PluginLoader } from './loader.js';

export { PluginSandbox } from './runtime.js';
export { GrayjayPluginAdapter } from './grayjay-adapter.js';
export { PluginLoader } from './loader.js';

// Default plugin configurations (pinned by content hash).
export const DEFAULT_PLUGINS: PluginConfig[] = [
  {
    id: 'e8b1ad5f-0c6d-497d-a5fa-0a785a16d902',
    name: 'BitChute (Beta)',
    platformId: 'bitchute',
    sourceUrl: 'https://plugins.grayjay.app/Bitchute/BitchuteConfig.json',
    scriptUrl: 'https://plugins.grayjay.app/Bitchute/BitchuteScript.js',
    contentHash: 'c74bdd92b0f112bf27c0b351fc9169bd0eabc121c57f9c30d8839d07ad96d253',
    version: 11,
    repositoryUrl: 'https://gitlab.futo.org/videostreaming/plugins/bitchute',
    iconUrl: 'https://plugins.grayjay.app/Bitchute/BitchuteIcon.png',
    packages: ['Http', 'DOMParser'],
  },
  {
    id: '2ce7b35e-d2b2-4adb-a728-a34a30d30359',
    name: 'Rumble',
    platformId: 'rumble',
    sourceUrl: 'https://plugins.grayjay.app/Rumble/RumbleConfig.json',
    scriptUrl: 'https://plugins.grayjay.app/Rumble/RumbleScript.js',
    contentHash: '348207d263f4dd0d1e544c8f47629cda27979c2c016b0d1d45eff016330049cf',
    version: 66,
    repositoryUrl: 'https://gitlab.futo.org/videostreaming/plugins/rumble',
    iconUrl: 'https://plugins.grayjay.app/Rumble/rumble.png',
    packages: ['Http', 'DOMParser'],
  },
];

export async function loadPlugins(
  configs: PluginConfig[],
  cache: ResourceCache,
  limiter: RateLimiter,
): Promise<GrayjayPluginAdapter[]> {
  const loader = new PluginLoader(cache);
  const adapters: GrayjayPluginAdapter[] = [];

  for (const config of configs) {
    try {
      const adapter = new GrayjayPluginAdapter(config, cache, limiter, config.platformId);
      const source = await loader.load(config);
      await adapter.initialize(source);
      adapters.push(adapter);
    } catch (err) {
      process.stderr.write(`[plugins] Failed to load plugin ${config.name}: ${err}\n`);
    }
  }

  return adapters;
}
