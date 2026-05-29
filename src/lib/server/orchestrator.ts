import { Orchestrator } from '$lib/jobs/orchestrator.js';
import { SqliteJobStore } from '$lib/jobs/sqlite-job-store.js';
import { ResourceCache } from '$lib/cache/resource-cache.js';
import { RateLimiter } from '$lib/rate-limit/rate-limiter.js';
import { join } from 'path';

let _orchestrator: Orchestrator | null = null;

export function getOrchestrator(): Orchestrator {
  if (!_orchestrator) {
    const store = new SqliteJobStore(
      join(process.cwd(), '.cache', 'untether', 'jobs.db')
    );
    const cache = new ResourceCache(
      join(process.cwd(), '.cache', 'untether')
    );
    const limiter = new RateLimiter();
    _orchestrator = new Orchestrator(store, cache, limiter);
  }
  return _orchestrator;
}
