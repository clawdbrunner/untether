import { Orchestrator } from '$lib/jobs/orchestrator.js';
import { SqliteJobStore } from '$lib/jobs/sqlite-job-store.js';
import { ResourceCache } from '$lib/cache/resource-cache.js';
import { RateLimiter } from '$lib/rate-limit/rate-limiter.js';
import { join } from 'path';

let _orchestrator: Orchestrator | null = null;
let _initPromise: Promise<Orchestrator> | null = null;

export async function getOrchestrator(): Promise<Orchestrator> {
  if (_orchestrator) return _orchestrator;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const store = new SqliteJobStore(
      join(process.cwd(), '.cache', 'untether', 'jobs.db')
    );
    const cache = new ResourceCache(
      join(process.cwd(), '.cache', 'untether')
    );
    const limiter = new RateLimiter();
    const orch = new Orchestrator(store, cache, limiter);

    // Run crash recovery on startup
    await orch.recover();

    _orchestrator = orch;
    return orch;
  })();

  return _initPromise;
}
