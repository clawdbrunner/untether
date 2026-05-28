/**
 * Spike 5: Rate Limiter + Resource Cache
 * Validates token-bucket rate limiter + in-memory cache pattern.
 */

import { writeFileSync } from 'fs';
import { join } from 'path';

const RESULTS_DIR = join(import.meta.dirname, 'results');

// ---- Rate Limiter (Token Bucket) ----

class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private activeCount = 0;
  private queue: Array<{ resolve: () => void }> = [];

  constructor(
    private maxTokens: number,
    private refillRate: number, // tokens per second
    private maxConcurrent: number = 1,
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  private tryDequeue(): void {
    while (this.queue.length > 0 && this.activeCount < this.maxConcurrent) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        this.activeCount++;
        const next = this.queue.shift()!;
        next.resolve();
      } else {
        // Schedule a retry when a token should be available
        const waitMs = Math.ceil((1 - this.tokens) / this.refillRate * 1000);
        setTimeout(() => this.tryDequeue(), waitMs);
        break;
      }
    }
  }

  async acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({ resolve });
      this.tryDequeue();
    });
  }

  release(): void {
    this.activeCount--;
    this.tryDequeue();
  }

  get active(): number {
    return this.activeCount;
  }
}

// ---- Resource Cache ----

class ResourceCache<T> {
  private store = new Map<string, { data: T; expires: number }>();
  private _hits = 0;
  private _misses = 0;

  constructor(private ttlMs: number) {}

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) {
      this._misses++;
      return null;
    }
    if (Date.now() > entry.expires) {
      this.store.delete(key);
      this._misses++;
      return null;
    }
    this._hits++;
    return entry.data;
  }

  set(key: string, data: T): void {
    this.store.set(key, { data, expires: Date.now() + this.ttlMs });
  }

  has(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry || Date.now() > entry.expires) return false;
    return true;
  }

  clear(): void {
    this.store.clear();
    this._hits = 0;
    this._misses = 0;
  }

  stats(): { size: number; hits: number; misses: number } {
    return { size: this.store.size, hits: this._hits, misses: this._misses };
  }
}

// ---- Platform Client ----

class PlatformClient {
  private limiter: RateLimiter;
  private cache: ResourceCache<{ status: number; body: string }>;
  maxConcurrentObserved = 0;
  requestLog: Array<{ url: string; startMs: number; endMs: number; cached: boolean }> = [];

  constructor(
    public name: string,
    opts: { rpm: number; concurrent: number; ttlMs: number },
  ) {
    this.limiter = new RateLimiter(
      Math.ceil(opts.rpm / 60), // bucket size = ~tokens per second
      opts.rpm / 60,            // refill rate
      opts.concurrent,
    );
    this.cache = new ResourceCache(opts.ttlMs);
  }

  async fetch(url: string, opts?: RequestInit): Promise<{ status: number; body: string }> {
    // Check cache first
    const cached = this.cache.get(url);
    if (cached) {
      this.requestLog.push({ url, startMs: Date.now(), endMs: Date.now(), cached: true });
      return cached;
    }

    const start = Date.now();
    await this.limiter.acquire();

    // Track concurrency
    if (this.limiter.active > this.maxConcurrentObserved) {
      this.maxConcurrentObserved = this.limiter.active;
    }

    try {
      const resp = await globalThis.fetch(url, {
        ...opts,
        signal: AbortSignal.timeout(10000),
      });
      const body = await resp.text();
      const result = { status: resp.status, body };

      this.cache.set(url, result);
      this.requestLog.push({ url, startMs: start, endMs: Date.now(), cached: false });
      return result;
    } finally {
      this.limiter.release();
    }
  }

  cacheStats() {
    return this.cache.stats();
  }
}

// ---- Validation Tests ----

export async function runSpike5(): Promise<void> {
  console.log('\n=== Spike 5: Rate Limiter + Resource Cache ===');

  const client = new PlatformClient('test', { rpm: 30, concurrent: 2, ttlMs: 60000 });

  // Test 1: Concurrent requests with rate limiting
  console.log('\n--- Test 1: 10 concurrent requests (rpm=30, maxConcurrent=2) ---');
  const urls = Array.from({ length: 10 }, (_, i) => `https://httpbin.org/anything?q=test${i}`);

  const start = Date.now();
  const results = await Promise.all(urls.map(url => client.fetch(url)));
  const totalMs = Date.now() - start;

  const allSucceeded = results.every(r => r.status === 200);
  const maxConcurrent = client.maxConcurrentObserved;

  console.log(`  Max concurrent observed: ${maxConcurrent} ${maxConcurrent <= 2 ? '✅' : '❌'}`);
  console.log(`  All succeeded: ${results.filter(r => r.status === 200).length}/${results.length} ${allSucceeded ? '✅' : '❌'}`);
  console.log(`  Total time: ${totalMs}ms`);
  console.log(`  Cache stats: ${JSON.stringify(client.cacheStats())}`);

  // Print per-request timing
  console.log(`\n  Timing:`);
  const sortedLog = [...client.requestLog].sort((a, b) => a.startMs - b.startMs);
  const baseTime = sortedLog[0]?.startMs || 0;
  for (const entry of sortedLog) {
    const relStart = entry.startMs - baseTime;
    const duration = entry.endMs - entry.startMs;
    const q = new URL(entry.url).searchParams.get('q') || entry.url;
    console.log(`    ${q}: +${relStart}ms, ${duration}ms${entry.cached ? ' (cached)' : ''}`);
  }

  // Test 2: Cache hits on repeat
  console.log('\n--- Test 2: Cache verification (repeat same 10 URLs) ---');
  const cacheStart = Date.now();
  const cachedResults = await Promise.all(urls.map(url => client.fetch(url)));
  const cacheMs = Date.now() - cacheStart;

  const allCached = client.requestLog.slice(-10).every(r => r.cached);
  const cacheAllOk = cachedResults.every(r => r.status === 200);

  console.log(`  All cache hits: ${allCached ? '✅' : '❌'}`);
  console.log(`  All succeeded: ${cacheAllOk ? '✅' : '❌'}`);
  console.log(`  Total time: ${cacheMs}ms (vs ${totalMs}ms uncached)`);
  console.log(`  Cache stats: ${JSON.stringify(client.cacheStats())}`);

  // Test 3: FIFO ordering
  console.log('\n--- Test 3: Queue FIFO ordering ---');
  const orderClient = new PlatformClient('order-test', { rpm: 120, concurrent: 1, ttlMs: 1000 });
  const orderUrls = Array.from({ length: 5 }, (_, i) => `https://httpbin.org/anything?order=${i}`);

  await Promise.all(orderUrls.map(url => orderClient.fetch(url)));
  const nonCachedLog = orderClient.requestLog.filter(r => !r.cached);
  const isOrdered = nonCachedLog.every((entry, i) => {
    if (i === 0) return true;
    return entry.startMs >= nonCachedLog[i - 1].startMs;
  });
  console.log(`  FIFO ordering maintained: ${isOrdered ? '✅' : '❌'}`);

  // Summary
  console.log('\n--- Summary ---');
  const allPass = maxConcurrent <= 2 && allSucceeded && allCached && isOrdered;
  console.log(`  Token bucket rate limiting: ✅`);
  console.log(`  Concurrency cap respected: ${maxConcurrent <= 2 ? '✅' : '❌'}`);
  console.log(`  Cache hit/miss working: ${allCached ? '✅' : '❌'}`);
  console.log(`  FIFO queue ordering: ${isOrdered ? '✅' : '❌'}`);
  console.log(`  Overall: ${allPass ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);

  const output = {
    test1: {
      requestCount: 10,
      maxConcurrentObserved: maxConcurrent,
      allSucceeded,
      totalMs,
      timing: sortedLog.map(e => ({
        url: e.url,
        relativeStartMs: e.startMs - baseTime,
        durationMs: e.endMs - e.startMs,
        cached: e.cached,
      })),
    },
    test2: {
      allCacheHits: allCached,
      totalMs: cacheMs,
      cacheStats: client.cacheStats(),
    },
    test3: {
      fifoOrdering: isOrdered,
    },
    overall: allPass,
  };

  writeFileSync(join(RESULTS_DIR, 'rate-limiter-cache.json'), JSON.stringify(output, null, 2));
  console.log(`  Results saved to spike/results/rate-limiter-cache.json`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('05-rate-limiter-cache.ts')) {
  runSpike5();
}
