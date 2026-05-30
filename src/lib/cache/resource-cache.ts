import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import type { YouTubeChannel, DeclaredLink, ChannelCandidate } from '../types.js';

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

const TTL_ENRICHMENT = 24 * 60 * 60 * 1000; // 24 hours
const TTL_SEARCH = 7 * 24 * 60 * 60 * 1000; // 7 days
const TTL_LINKS = 24 * 60 * 60 * 1000;
const TTL_AVATAR = 7 * 24 * 60 * 60 * 1000;

export class ResourceCache {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    for (const sub of ['enrichment', 'links', 'search/peertube', 'search/odysee', 'search/bitchute', 'search/rumble', 'avatars', 'scrape', 'plugins']) {
      mkdirSync(join(this.baseDir, sub), { recursive: true });
    }
  }

  // --- Enrichment ---
  async getEnrichment(channelId: string): Promise<Partial<YouTubeChannel> | null> {
    return this.read(join('enrichment', `${channelId}.json`), TTL_ENRICHMENT);
  }

  async setEnrichment(channelId: string, data: Partial<YouTubeChannel>): Promise<void> {
    this.write(join('enrichment', `${channelId}.json`), data);
  }

  // --- Declared links ---
  async getDeclaredLinks(channelId: string): Promise<DeclaredLink[] | null> {
    return this.read(join('links', `${channelId}.json`), TTL_LINKS);
  }

  async setDeclaredLinks(channelId: string, links: DeclaredLink[]): Promise<void> {
    this.write(join('links', `${channelId}.json`), links);
  }

  // --- Search results ---
  async getSearchResults(platform: string, query: string): Promise<ChannelCandidate[] | null> {
    const hash = this.hashKey(query.toLowerCase().trim());
    return this.read(join('search', platform, `${hash}.json`), TTL_SEARCH);
  }

  async setSearchResults(platform: string, query: string, results: ChannelCandidate[]): Promise<void> {
    const hash = this.hashKey(query.toLowerCase().trim());
    this.write(join('search', platform, `${hash}.json`), results);
  }

  // --- Scrape status ---
  async getScrapeStatus(channelId: string): Promise<'success' | 'blocked' | 'failed' | null> {
    const entry = this.read<{ status: string }>(join('scrape', `${channelId}.json`), TTL_LINKS);
    if (!entry) return null;
    return (entry as { status: string }).status as 'success' | 'blocked' | 'failed';
  }

  async setScrapeStatus(channelId: string, status: string): Promise<void> {
    this.write(join('scrape', `${channelId}.json`), { status });
  }

  // --- Avatar hash ---
  async getAvatarHash(url: string): Promise<string | null> {
    const hash = this.hashKey(url);
    return this.read(join('avatars', `${hash}.json`), TTL_AVATAR);
  }

  async setAvatarHash(url: string, hash: string): Promise<void> {
    const key = this.hashKey(url);
    this.write(join('avatars', `${key}.json`), hash);
  }

  // --- Plugin scripts ---
  async getPluginScript(hash: string): Promise<string | null> {
    const fullPath = join(this.baseDir, 'plugins', `${hash}.js`);
    if (!existsSync(fullPath)) return null;
    try {
      return readFileSync(fullPath, 'utf-8');
    } catch {
      return null;
    }
  }

  async setPluginScript(hash: string, script: string): Promise<void> {
    const fullPath = join(this.baseDir, 'plugins', `${hash}.js`);
    writeFileSync(fullPath, script);
  }

  // --- Sync helpers for orchestrator ---

  /**
   * Synchronous read — for internal use by orchestrator.
   */
  readSync<T>(relPath: string): T | null {
    const fullPath = join(this.baseDir, relPath + '.json');
    if (!existsSync(fullPath)) return null;
    try {
      const raw = readFileSync(fullPath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /**
   * Synchronous write — for internal use by orchestrator.
   */
  writeSync<T>(relPath: string, data: T): void {
    const fullPath = join(this.baseDir, relPath + '.json');
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, JSON.stringify(data));
  }

  // --- Internal helpers ---
  private read<T>(relPath: string, ttl: number): T | null {
    const fullPath = join(this.baseDir, relPath);
    if (!existsSync(fullPath)) return null;
    try {
      const raw = readFileSync(fullPath, 'utf-8');
      const entry: CacheEntry<T> = JSON.parse(raw);
      if (Date.now() - entry.fetchedAt > ttl) return null;
      return entry.data;
    } catch {
      return null;
    }
  }

  private write<T>(relPath: string, data: T): void {
    const fullPath = join(this.baseDir, relPath);
    const entry: CacheEntry<T> = { data, fetchedAt: Date.now() };
    writeFileSync(fullPath, JSON.stringify(entry, null, 2));
  }

  private hashKey(input: string): string {
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
  }
}
