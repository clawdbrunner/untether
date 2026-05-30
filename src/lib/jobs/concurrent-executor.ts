import type { Task, ErrorClass } from '../types.js';
import type { JobStore } from './interfaces.js';
import type { RateLimiter } from '../rate-limit/rate-limiter.js';
import { classifyError, errorClassToTaskStatus, getBackoffForClass, BACKOFF_CONFIG } from './error-classifier.js';

export interface ExecutorConfig {
  globalConcurrency: number;  // default 12
}

interface TaskGroup {
  source: string;
  tasks: Task[];
}

export type TaskHandler = (task: Task) => Promise<{
  success: boolean;
  result?: unknown;
  error?: string;
  errorClass?: ErrorClass;
}>;

export class ConcurrentExecutor {
  private store: JobStore;
  private limiter: RateLimiter;
  private config: ExecutorConfig;
  private activeCount = 0;
  private globalQueue: Array<() => void> = [];

  constructor(store: JobStore, limiter: RateLimiter, config?: Partial<ExecutorConfig>) {
    this.store = store;
    this.limiter = limiter;
    this.config = { globalConcurrency: 12, ...config };
  }

  /**
   * Execute tasks concurrently across sources, bounded per-source by the rate limiter.
   *
   * NON-NEGOTIABLE: Every task acquires a slot from the per-source limiter
   * via limiter.acquire(source). The limiter decides when the task actually runs.
   */
  async execute(
    tasks: Task[],
    handler: TaskHandler,
    signal: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<number> {
    const groups = this.groupBySource(tasks);
    let completed = 0;
    const total = tasks.length;

    const sourceQueues = groups.map(group =>
      this.drainSourceQueue(group, handler, signal, () => {
        completed++;
        onProgress?.(completed, total);
      })
    );

    await Promise.all(sourceQueues);
    return completed;
  }

  private async drainSourceQueue(
    group: TaskGroup,
    handler: TaskHandler,
    signal: AbortSignal,
    onTaskDone: () => void,
  ): Promise<void> {
    for (const task of group.tasks) {
      if (signal.aborted) break;

      // Acquire global concurrency slot
      await this.acquireGlobal();

      // Acquire per-source rate limiter slot (NON-NEGOTIABLE)
      let release: (() => void) | null = null;
      try {
        release = await this.limiter.acquire(group.source);
      } catch (err) {
        // Circuit breaker open — mark task as skipped
        await this.store.updateTaskStatus(task.id, 'skipped', undefined, String(err), 'blocked', 'Circuit breaker open');
        this.releaseGlobal();
        onTaskDone();
        continue;
      }

      try {
        await this.store.updateTaskStatus(task.id, 'in_flight');
        const result = await handler(task);

        if (result.success) {
          this.limiter.reportSuccess(group.source);
          await this.store.updateTaskStatus(task.id, 'succeeded', result.result);
        } else {
          const errClass = result.errorClass ?? classifyError({ errorMessage: result.error });
          const targetStatus = errorClassToTaskStatus(errClass);

          if (errClass === 'rate_limited' || errClass === 'blocked') {
            this.limiter.reportFailure(group.source);
          }

          const maxForClass = BACKOFF_CONFIG[errClass]?.maxAttempts ?? task.maxAttempts;
          if (targetStatus === 'failed_retryable' && task.attempts + 1 >= maxForClass) {
            await this.store.updateTaskStatus(task.id, 'failed_permanent', undefined, result.error, errClass, `Exhausted ${maxForClass} attempts`);
          } else {
            await this.store.updateTaskStatus(task.id, targetStatus, undefined, result.error, errClass, result.error);
          }
        }
      } finally {
        release();
        this.releaseGlobal();
        onTaskDone();
      }
    }
  }

  private async acquireGlobal(): Promise<void> {
    if (this.activeCount < this.config.globalConcurrency) {
      this.activeCount++;
      return;
    }
    return new Promise<void>(resolve => {
      this.globalQueue.push(() => {
        this.activeCount++;
        resolve();
      });
    });
  }

  private releaseGlobal(): void {
    this.activeCount--;
    if (this.globalQueue.length > 0) {
      this.globalQueue.shift()!();
    }
  }

  private groupBySource(tasks: Task[]): TaskGroup[] {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      const source = task.kind.startsWith('search:')
        ? task.kind.replace('search:', '')
        : task.kind === 'scrape_links' ? 'youtube-web'
        : task.kind === 'enrich' ? 'youtube-api'
        : task.kind;
      if (!map.has(source)) map.set(source, []);
      map.get(source)!.push(task);
    }
    return Array.from(map.entries()).map(([source, tasks]) => ({ source, tasks }));
  }
}
