export interface ProxyConfig {
  /** SOCKS5 or HTTP CONNECT URL, e.g. "socks5://user:pass@host:port" */
  url: string;
  /** Which sources to apply this proxy to. Empty = all sources. */
  sources: string[];
}

/**
 * Load proxy configuration from environment variables.
 * Format: PROXY_<SOURCE>=socks5://user:pass@host:port
 * Special: PROXY_ALL or PROXY_DEFAULT applies to all sources.
 */
export function loadProxyConfigFromEnv(): ProxyConfig[] {
  const configs: ProxyConfig[] = [];

  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;

    if (key === 'PROXY_ALL' || key === 'PROXY_DEFAULT') {
      configs.push({ url: value, sources: [] });
    } else if (key.startsWith('PROXY_')) {
      const source = key.replace('PROXY_', '').toLowerCase();
      if (source) {
        configs.push({ url: value, sources: [source] });
      }
    }
  }

  return configs;
}

/**
 * Get the proxy URL for a given source, if configured.
 * Source-specific proxies take priority over catch-all.
 */
export function getProxyForSource(source: string, configs: ProxyConfig[]): string | null {
  for (const config of configs) {
    if (config.sources.length === 0) continue;
    if (config.sources.includes(source)) return config.url;
  }
  for (const config of configs) {
    if (config.sources.length === 0) return config.url;
  }
  return null;
}
