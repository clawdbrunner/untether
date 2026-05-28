interface TokenBucket {
  tokens: number;
  maxTokens: number;
  refillRate: number; // tokens per second
  lastRefill: number;
}

interface ConcurrencySlot {
  current: number;
  max: number;
  queue: Array<() => void>;
}

interface CircuitBreaker {
  failures: number;
  lastFailure: number;
  state: 'closed' | 'open' | 'half-open';
  tripThreshold: number;
  cooldownMs: number;
}

const SOURCE_DEFAULTS: Record<string, { maxTokens: number; refillRate: number; maxConcurrent: number }> = {
  'youtube-web': { maxTokens: 5, refillRate: 0.5, maxConcurrent: 2 },
  'youtube-api': { maxTokens: 10, refillRate: 1, maxConcurrent: 3 },
  'peertube': { maxTokens: 10, refillRate: 1, maxConcurrent: 3 },
  'odysee': { maxTokens: 10, refillRate: 1, maxConcurrent: 3 },
};

export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private concurrency = new Map<string, ConcurrencySlot>();
  private circuits = new Map<string, CircuitBreaker>();

  constructor(overrides?: Record<string, { maxTokens?: number; refillRate?: number; maxConcurrent?: number }>) {
    for (const [source, defaults] of Object.entries(SOURCE_DEFAULTS)) {
      const o = overrides?.[source];
      this.buckets.set(source, {
        tokens: o?.maxTokens ?? defaults.maxTokens,
        maxTokens: o?.maxTokens ?? defaults.maxTokens,
        refillRate: o?.refillRate ?? defaults.refillRate,
        lastRefill: Date.now(),
      });
      this.concurrency.set(source, {
        current: 0,
        max: o?.maxConcurrent ?? defaults.maxConcurrent,
        queue: [],
      });
      this.initCircuit(source);
    }
  }

  private initCircuit(source: string): void {
    this.circuits.set(source, {
      failures: 0,
      lastFailure: 0,
      state: 'closed',
      tripThreshold: 3,
      cooldownMs: 30_000,
    });
  }

  async acquire(source: string): Promise<() => void> {
    this.ensureSource(source);

    // Check circuit breaker first
    if (!this.isAvailable(source)) {
      throw new Error(`Circuit breaker open for ${source} — too many failures`);
    }

    await this.waitForToken(source);
    await this.waitForSlot(source);

    return () => {
      const slot = this.concurrency.get(source)!;
      slot.current--;
      if (slot.queue.length > 0) {
        slot.queue.shift()!();
      }
    };
  }

  /** Call when a request succeeds. Resets failure count. */
  reportSuccess(source: string): void {
    const cb = this.circuits.get(source);
    if (cb) {
      cb.failures = 0;
      cb.state = 'closed';
    }
  }

  /** Call when a request fails (429, 403, network error). */
  reportFailure(source: string): void {
    const cb = this.circuits.get(source);
    if (!cb) return;
    cb.failures++;
    cb.lastFailure = Date.now();
    if (cb.failures >= cb.tripThreshold) {
      cb.state = 'open';
      process.stderr.write(`[rate-limiter] Circuit breaker OPEN for ${source} after ${cb.failures} failures\n`);
    }
  }

  getCircuitStatus(source: string): 'closed' | 'open' | 'half-open' {
    return this.circuits.get(source)?.state ?? 'closed';
  }

  getAllCircuitStatus(): Map<string, 'closed' | 'open' | 'half-open'> {
    const result = new Map<string, 'closed' | 'open' | 'half-open'>();
    for (const [source, cb] of this.circuits) {
      result.set(source, cb.state);
    }
    return result;
  }

  private ensureSource(source: string): void {
    if (!this.buckets.has(source)) {
      // Default for unknown sources
      this.buckets.set(source, { tokens: 10, maxTokens: 10, refillRate: 1, lastRefill: Date.now() });
      this.concurrency.set(source, { current: 0, max: 3, queue: [] });
      this.initCircuit(source);
    }
  }

  private isAvailable(source: string): boolean {
    const cb = this.circuits.get(source);
    if (!cb || cb.state === 'closed') return true;

    if (cb.state === 'open') {
      if (Date.now() - cb.lastFailure >= cb.cooldownMs) {
        cb.state = 'half-open';
        return true;
      }
      return false;
    }

    // half-open: allow the request (will transition based on result)
    return true;
  }

  private async waitForToken(source: string): Promise<void> {
    const bucket = this.buckets.get(source)!;

    while (true) {
      this.refill(bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens--;
        return;
      }
      // Calculate base wait, then add jitter (±30%)
      const baseWaitMs = Math.ceil((1 - bucket.tokens) / bucket.refillRate * 1000);
      const jitterMs = Math.floor(baseWaitMs * 0.3 * Math.random());
      await sleep(baseWaitMs + jitterMs);
    }
  }

  private async waitForSlot(source: string): Promise<void> {
    const slot = this.concurrency.get(source)!;
    if (slot.current < slot.max) {
      slot.current++;
      // Small startup jitter (50-200ms)
      await sleep(50 + Math.floor(Math.random() * 150));
      return;
    }
    return new Promise<void>((resolve) => {
      slot.queue.push(() => {
        slot.current++;
        resolve();
      });
    });
  }

  private refill(bucket: TokenBucket): void {
    const now = Date.now();
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + elapsed * bucket.refillRate);
    bucket.lastRefill = now;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
