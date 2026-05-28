import { readFileSync } from 'fs';
import { join } from 'path';

export interface PlatformEntry {
  name: string;
  url: string;
  grayjaySource: string;
  ytdlpExtractor: string;
  domains: string[];
}

export class PlatformRegistry {
  private entries: PlatformEntry[] = [];
  private domainMap = new Map<string, PlatformEntry>();
  private peertubeInstances = new Set<string>();

  constructor(csvPath?: string) {
    const basePath = csvPath || join(process.cwd(), 'data', 'platform-registry.csv');
    this.load(basePath);
    this.loadInstances(join(process.cwd(), 'data', 'peertube-instances.txt'));
  }

  private load(csvPath: string): void {
    let content: string;
    try {
      content = readFileSync(csvPath, 'utf-8');
    } catch {
      return; // File not found — registry will be empty
    }

    const lines = content.split('\n').filter((l) => l.trim());
    // Skip header
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 4) continue;

      const name = parts[0].trim();
      const url = parts[1].trim();
      const grayjaySource = parts[2].trim();
      const ytdlpExtractor = parts[3].trim();

      const domains: string[] = [];
      try {
        const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
        domains.push(hostname);
      } catch {
        // Invalid URL — skip domain extraction
      }

      const entry: PlatformEntry = { name, url, grayjaySource, ytdlpExtractor, domains };
      this.entries.push(entry);
      for (const domain of domains) {
        this.domainMap.set(domain, entry);
      }
    }
  }

  private loadInstances(path: string): void {
    try {
      const content = readFileSync(path, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) this.peertubeInstances.add(trimmed.toLowerCase());
      }
    } catch {
      /* File not found — rely on URL patterns only */
    }
  }

  /** Look up a platform by domain. Returns the entry or null. */
  lookup(url: string): PlatformEntry | null {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      if (this.domainMap.has(hostname)) return this.domainMap.get(hostname)!;
      const stripped = hostname.replace(/^www\./, '');
      if (this.domainMap.has(stripped)) return this.domainMap.get(stripped)!;
      return null;
    } catch {
      return null;
    }
  }

  /** Check if a URL belongs to a known video/audio platform. */
  isPlatformUrl(url: string): boolean {
    return this.lookup(url) !== null;
  }

  /** Get the platform name for a URL, or 'unknown'. */
  classifyUrl(url: string): string {
    return this.lookup(url)?.name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'unknown';
  }

  /** Classify URL into our target platform types. */
  classifyForMatch(url: string): 'peertube' | 'odysee' | 'rumble' | null {
    if (this.isPeerTubeUrl(url)) return 'peertube';
    const entry = this.lookup(url);
    if (!entry) return null;
    if (entry.name === 'PeerTube') return 'peertube';
    if (entry.name === 'Odysee') return 'odysee';
    if (entry.name === 'Rumble') return 'rumble';
    return null;
  }

  /** Check if a URL is a PeerTube instance. */
  isPeerTubeUrl(url: string): boolean {
    try {
      const u = new URL(url);
      const path = u.pathname.toLowerCase();
      // PeerTube-specific path patterns
      if (path.includes('/video-channels/') || path.includes('/videos/watch/')) return true;
      // Check known instances list
      const hostname = u.hostname.toLowerCase();
      if (this.peertubeInstances.has(hostname)) return true;
      if (this.peertubeInstances.has(hostname.replace(/^www\./, ''))) return true;
      // Check registry
      const entry = this.lookup(url);
      if (entry?.name === 'PeerTube') return true;
      return false;
    } catch {
      return false;
    }
  }

  /** Get all entries. */
  getAll(): PlatformEntry[] {
    return [...this.entries];
  }

  /** Get entry for a specific platform name. */
  getByName(name: string): PlatformEntry | undefined {
    return this.entries.find((e) => e.name === name);
  }
}

let _instance: PlatformRegistry | null = null;

export function getRegistry(): PlatformRegistry {
  if (!_instance) _instance = new PlatformRegistry();
  return _instance;
}
