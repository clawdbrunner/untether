import { join } from 'path';
import type {
  PipelineConfig,
  PipelineResult,
  YouTubeChannel,
  MatchResult,
  Job,
  Task,
  TaskKind,
  ProgressEvent,
} from '../types.js';
import { SqliteJobStore } from './sqlite-job-store.js';
import { ResourceCache } from '../cache/resource-cache.js';
import { RateLimiter } from '../rate-limit/rate-limiter.js';
import { parseTakeoutCsv } from '../ingest/takeout-parser.js';
import { enrichChannels } from '../enrichment/enricher.js';
import { extractDeclaredLinks } from '../links/link-extractor.js';
import { matchChannel } from '../matching/matcher.js';
import { PeerTubeAdapter } from '../adapters/peertube.js';
import { OdyseeAdapter } from '../adapters/odysee.js';
import { DailymotionAdapter } from '../adapters/dailymotion.js';
import type { PlatformAdapter } from '../adapters/adapter-interface.js';
import { GrayjayPluginAdapter } from '../plugins/grayjay-adapter.js';
import { classifyError, errorClassToTaskStatus, getBackoffForClass, BACKOFF_CONFIG } from './error-classifier.js';
import { ConcurrentExecutor } from './concurrent-executor.js';
import type { ErrorClass } from '../types.js';

export class Orchestrator {
  store: SqliteJobStore;
  private cache: ResourceCache;
  private limiter: RateLimiter;

  // Active runs — jobId → AbortController
  private activeRuns = new Map<string, AbortController>();

  // Progress callbacks — jobId → callback
  private progressCallbacks = new Map<string, (event: ProgressEvent) => void>();

  constructor(store?: SqliteJobStore, cache?: ResourceCache, limiter?: RateLimiter) {
    this.store = store ?? new SqliteJobStore();
    this.cache = cache ?? new ResourceCache(join(process.cwd(), '.cache', 'untether'));
    this.limiter = limiter ?? new RateLimiter();
  }

  /**
   * Create a new job from CSV text. Does NOT start it.
   */
  async createJob(csvText: string, config: PipelineConfig): Promise<Job> {
    // Parse CSV to get channel list
    const channels = parseTakeoutCsv(csvText);
    const channelIds = channels.map((c) => c.id);

    // Create job in store
    const job = await this.store.createJob(config, channelIds);

    // Generate tasks for this job
    const tasks: Omit<Task, 'id'>[] = [];
    const now = Date.now();
    for (const ch of channels) {
      // Enrichment task
      tasks.push({
        jobId: job.id,
        kind: 'enrich',
        targetKey: ch.id,
        status: 'pending',
        attempts: 0,
        maxAttempts: 3,
        updatedAt: now,
      });

      // Scrape links task
      tasks.push({
        jobId: job.id,
        kind: 'scrape_links',
        targetKey: ch.id,
        status: 'pending',
        attempts: 0,
        maxAttempts: 3,
        updatedAt: now,
      });

      // Search tasks per platform
      for (const platform of config.platforms) {
        tasks.push({
          jobId: job.id,
          kind: `search:${platform}` as TaskKind,
          targetKey: `${ch.id}:${platform}`,
          status: 'pending',
          attempts: 0,
          maxAttempts: 3,
          updatedAt: now,
        });
      }
    }

    await this.store.createTasks(job.id, tasks);

    // Update total task count
    await this.store.updateJobProgress(job.id, 0, tasks.length);

    // Store channel data in resource cache for task execution
    this.cache.writeSync('_job_channels/' + job.id, channels);

    return job;
  }

  /**
   * Start (or resume) running a job.
   * Returns immediately; work happens in background.
   */
  async startJob(jobId: string): Promise<void> {
    if (this.activeRuns.has(jobId)) {
      throw new Error(`Job ${jobId} is already running`);
    }

    const job = await this.store.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.status === 'completed') throw new Error(`Job ${jobId} is already completed`);

    const abortController = new AbortController();
    this.activeRuns.set(jobId, abortController);

    // Update status
    await this.store.updateJobStatus(jobId, 'running');

    // Run in background (don't await)
    this.runJobLoop(jobId, job, abortController.signal).catch(async (err) => {
      process.stderr.write(`[orchestrator] Job ${jobId} failed: ${err}\n`);
      await this.store.updateJobStatus(jobId, 'failed');
      this.activeRuns.delete(jobId);
    });
  }

  /**
   * Pause a running job.
   * In-flight tasks finish, no new tasks are scheduled.
   */
  async pauseJob(jobId: string): Promise<void> {
    const ac = this.activeRuns.get(jobId);
    if (ac) {
      ac.abort(); // Signal the loop to stop
    }
    await this.store.updateJobStatus(jobId, 'paused');
  }

  /**
   * Resume a paused job.
   * Re-derives pending tasks, skips anything already in resource cache.
   */
  async resumeJob(jobId: string): Promise<void> {
    const job = await this.store.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.status !== 'paused' && job.status !== 'failed') {
      throw new Error(`Job ${jobId} cannot be resumed (status: ${job.status})`);
    }

    await this.startJob(jobId);
  }

  /**
   * Recover from a crash. Resets orphaned running tasks and jobs.
   * Call once on application startup.
   */
  async recover(): Promise<{ tasksReset: number; jobsReset: number }> {
    // Reset orphaned running tasks back to pending
    const tasksReset = await this.store.resetOrphanedTasks();

    // Reset jobs that were running (they can be resumed)
    let jobsReset = 0;
    const runningJobs = await this.store.listJobs('running');
    for (const job of runningJobs) {
      await this.store.updateJobStatus(job.id, 'paused');
      jobsReset++;
    }

    if (tasksReset > 0 || jobsReset > 0) {
      process.stderr.write(
        `[orchestrator] Recovery: reset ${tasksReset} orphaned tasks, ${jobsReset} running jobs → paused\n`
      );
    }

    return { tasksReset, jobsReset };
  }

  /**
   * Get current job state.
   */
  async getJob(jobId: string): Promise<Job | null> {
    return this.store.getJob(jobId);
  }

  /**
   * Get match results for a completed (or in-progress) job.
   * Assembles results from task results.
   */
  async getJobResults(jobId: string): Promise<PipelineResult | null> {
    const job = await this.store.getJob(jobId);
    if (!job) return null;

    const tasks = await this.store.getTasksByJob(jobId);
    const channels: YouTubeChannel[] =
      this.cache.readSync<YouTubeChannel[]>('_job_channels/' + jobId) ?? [];

    // Collect match results from search tasks
    const matches: MatchResult[] = [];
    for (const task of tasks) {
      if (task.kind.startsWith('search:') && task.result) {
        const matchResult = task.result as MatchResult;
        matches.push(matchResult);
      }
    }

    // Calculate stats
    let verified = 0,
      likely = 0,
      possible = 0,
      weak = 0;
    for (const match of matches) {
      const top = match.candidates[0];
      if (!top) continue;
      switch (top.tier) {
        case 'verified':
          verified++;
          break;
        case 'likely':
          likely++;
          break;
        case 'possible':
          possible++;
          break;
        case 'weak':
          weak++;
          break;
      }
    }

    const enriched = tasks.filter((t) => t.kind === 'enrich' && t.status === 'succeeded').length;
    const declaredLinks = tasks
      .filter((t) => t.kind === 'scrape_links' && t.status === 'succeeded')
      .reduce((sum, t) => sum + ((t.result as { linkCount: number })?.linkCount ?? 0), 0);

    return {
      channels,
      matches,
      stats: {
        totalChannels: channels.length,
        enriched,
        enrichmentFailed: channels.length - enriched,
        declaredLinksFound: declaredLinks,
        verifiedMatches: verified,
        likelyMatches: likely,
        possibleMatches: possible,
        weakMatches: weak,
      },
    };
  }

  /**
   * Delete a job and all its data.
   */
  async deleteJob(jobId: string): Promise<void> {
    const ac = this.activeRuns.get(jobId);
    if (ac) {
      ac.abort();
      this.activeRuns.delete(jobId);
    }
    await this.store.deleteJob(jobId);
  }

  /**
   * Register a progress callback for a job.
   */
  onProgress(jobId: string, callback: (event: ProgressEvent) => void): void {
    this.progressCallbacks.set(jobId, callback);
  }

  /**
   * Cleanup old jobs.
   */
  async cleanup(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    return this.store.deleteJobsOlderThan(maxAgeMs);
  }

  /**
   * Close the store and release resources.
   */
  close(): void {
    for (const [, ac] of this.activeRuns) {
      ac.abort();
    }
    this.activeRuns.clear();
    this.store.close();
  }

  /**
   * Retry failed_retryable tasks for a completed/failed job.
   * Returns the number of tasks retried.
   */
  async retryFailed(jobId: string): Promise<number> {
    const job = await this.store.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    const retryable = await this.store.getRetryableTasks(jobId);
    if (retryable.length === 0) return 0;

    const channels: YouTubeChannel[] =
      this.cache.readSync<YouTubeChannel[]>('_job_channels/' + jobId) ?? [];
    const adapters = this.createAdapters(job.options);
    const executor = new ConcurrentExecutor(this.store, this.limiter, {
      globalConcurrency: job.options.maxConcurrent ?? 12,
    });

    const signal = new AbortController().signal;
    await executor.execute(
      retryable,
      async (task) => {
        if (!task.kind.startsWith('search:')) {
          return { success: false, error: 'Only search tasks can be retried', errorClass: 'permanent' as ErrorClass };
        }
        const [channelId, platform] = task.targetKey.split(':');
        const ch = channels.find((c) => c.id === channelId);
        if (!ch) return { success: false, error: 'Channel not found', errorClass: 'permanent' as ErrorClass };

        const adapter = adapters.get(platform);
        if (!adapter) return { success: false, error: `No adapter for ${platform}`, errorClass: 'permanent' as ErrorClass };

        try {
          const links = (await this.cache.getDeclaredLinks(ch.id)) ?? [];
          const matchResult = await matchChannel(
            ch,
            platform as 'peertube' | 'odysee' | 'dailymotion' | 'bitchute' | 'rumble',
            adapter,
            links,
            this.cache,
            this.limiter,
          );
          return { success: true, result: matchResult };
        } catch (err) {
          const errClass = classifyError({ errorMessage: String(err) });
          return { success: false, error: String(err), errorClass: errClass };
        }
      },
      signal,
    );

    return retryable.length;
  }

  // --- Internal ---

  private report(
    jobId: string,
    phase: ProgressEvent['phase'],
    current: number,
    total: number,
    message: string,
  ): void {
    const cb = this.progressCallbacks.get(jobId);
    if (cb) {
      cb({ phase, current, total, message });
    }
  }

  private async runJobLoop(jobId: string, job: Job, signal: AbortSignal): Promise<void> {
    const BATCH_SIZE = 5;
    const channels: YouTubeChannel[] =
      this.cache.readSync<YouTubeChannel[]>('_job_channels/' + jobId) ?? [];

    if (channels.length === 0) {
      throw new Error('No channel data found for job');
    }

    const adapters = this.createAdapters(job.options);
    let totalCompleted = 0;

    // Phase 1: Enrichment tasks
    this.report(jobId, 'enrich', 0, channels.length, 'Starting enrichment...');
    totalCompleted += await this.processTasks(
      jobId,
      'enrich',
      BATCH_SIZE,
      signal,
      async (task) => {
        const ch = channels.find((c) => c.id === task.targetKey);
        if (!ch) return { success: false, error: 'Channel not found' };

        // Skip if already enriched in cache
        const cached = await this.cache.getEnrichment(ch.id);
        if (cached) {
          Object.assign(ch, cached, { id: ch.id, title: ch.title, url: ch.url });
          return { success: true, result: { channelId: ch.id } };
        }

        try {
          await enrichChannels([ch], job.options, this.cache, this.limiter);
          return { success: true, result: { channelId: ch.id } };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      },
    );

    // Persist enriched channel data back to cache
    this.cache.writeSync('_job_channels/' + jobId, channels);

    // Phase 2: Scrape links tasks
    this.report(jobId, 'links', 0, channels.length, 'Extracting declared links...');
    totalCompleted += await this.processTasks(
      jobId,
      'scrape_links',
      BATCH_SIZE,
      signal,
      async (task) => {
        const ch = channels.find((c) => c.id === task.targetKey);
        if (!ch) return { success: false, error: 'Channel not found' };

        // Skip if already scraped successfully
        const scrapeStatus = await this.cache.getScrapeStatus(ch.id);
        if (scrapeStatus === 'success') {
          const cachedLinks = await this.cache.getDeclaredLinks(ch.id);
          return { success: true, result: { linkCount: cachedLinks?.length ?? 0 } };
        }

        try {
          const links = await extractDeclaredLinks(ch, this.cache, this.limiter);
          return { success: true, result: { linkCount: links.length } };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      },
    );

    // Persist again (handles may have been extracted from about pages)
    this.cache.writeSync('_job_channels/' + jobId, channels);

    // Phase 3: Search + match tasks — CONCURRENT across sources
    const allTasks = await this.store.getTasksByJob(jobId);
    const searchTasks = allTasks.filter(t => t.kind.startsWith('search:') && (t.status === 'pending' || t.status === 'failed_retryable'));
    const executor = new ConcurrentExecutor(this.store, this.limiter, {
      globalConcurrency: job.options.maxConcurrent ?? 12,
    });

    const searchHandler = async (task: Task) => {
      const [channelId, platform] = task.targetKey.split(':');
      const ch = channels.find((c) => c.id === channelId);
      if (!ch) return { success: false, error: 'Channel not found', errorClass: 'permanent' as ErrorClass };

      const adapter = adapters.get(platform);
      if (!adapter) return { success: false, error: `No adapter for ${platform}`, errorClass: 'permanent' as ErrorClass };

      try {
        const links = (await this.cache.getDeclaredLinks(ch.id)) ?? [];
        const matchResult = await matchChannel(
          ch,
          platform as 'peertube' | 'odysee' | 'dailymotion' | 'bitchute' | 'rumble',
          adapter,
          links,
          this.cache,
          this.limiter,
        );
        return { success: true, result: matchResult };
      } catch (err) {
        const errClass = classifyError({ errorMessage: String(err) });
        return { success: false, error: String(err), errorClass: errClass };
      }
    };

    this.report(jobId, 'match', 0, searchTasks.length, 'Matching across platforms...');
    totalCompleted += await executor.execute(
      searchTasks,
      searchHandler,
      signal,
      (completed, total) => this.report(jobId, 'match', completed, total, `Matching...`),
    );

    // Auto-retry passes (up to 2 passes)
    const MAX_RETRY_PASSES = 2;
    for (let retryPass = 0; retryPass < MAX_RETRY_PASSES; retryPass++) {
      if (signal.aborted) break;
      const retryableTasks = await this.store.getRetryableTasks(jobId);
      if (retryableTasks.length === 0) break;

      this.report(jobId, 'match', 0, retryableTasks.length, `Retry pass ${retryPass + 1}: ${retryableTasks.length} tasks`);
      await executor.execute(retryableTasks, searchHandler, signal, (completed, total) =>
        this.report(jobId, 'match', completed, total, `Retry pass ${retryPass + 1}...`),
      );
    }

    // Job complete
    if (!signal.aborted) {
      await this.store.updateJobStatus(jobId, 'completed');
      const finalTasks = await this.store.getTasksByJob(jobId);
      const completedCount = finalTasks.filter((t) => t.status === 'succeeded').length;
      await this.store.updateJobProgress(jobId, completedCount, finalTasks.length);
      this.report(jobId, 'match', completedCount, finalTasks.length, 'Pipeline complete');

      // Log per-platform summary
      this.logRunSummary(finalTasks);
    }

    this.activeRuns.delete(jobId);
  }

  /**
   * Process tasks of a given kind in batches.
   * Returns the number of tasks processed.
   */
  private async processTasks(
    jobId: string,
    kind: string,
    batchSize: number,
    signal: AbortSignal,
    handler: (task: Task) => Promise<{ success: boolean; result?: unknown; error?: string; errorClass?: ErrorClass }>,
  ): Promise<number> {
    let processed = 0;

    while (!signal.aborted) {
      const tasks = await this.store.getNextPendingTasks(jobId, batchSize);
      // Filter to only tasks of the right kind
      const matching = tasks.filter((t) => t.kind === kind);
      if (matching.length === 0) break;

      // Process in parallel (up to batchSize)
      await Promise.allSettled(
        matching.map(async (task) => {
          await this.store.updateTaskStatus(task.id, 'in_flight');
          const result = await handler(task);

          if (result.success) {
            // Report success to limiter for the source
            const source = this.extractSource(task);
            if (source) this.limiter.reportSuccess(source);
            await this.store.updateTaskStatus(task.id, 'succeeded', result.result);
          } else {
            // Classify the error
            const errClass = result.errorClass ?? classifyError({ errorMessage: result.error });
            const targetStatus = errorClassToTaskStatus(errClass);
            const source = this.extractSource(task);

            // Report to limiter for rate_limited/blocked
            if (source && (errClass === 'rate_limited' || errClass === 'blocked')) {
              this.limiter.reportFailure(source);
            }

            // Check max attempts for retryable errors
            const maxForClass = BACKOFF_CONFIG[errClass]?.maxAttempts ?? task.maxAttempts;
            if (targetStatus === 'failed_retryable' && task.attempts + 1 >= maxForClass) {
              await this.store.updateTaskStatus(task.id, 'failed_permanent', undefined, result.error, errClass, `Exhausted ${maxForClass} attempts`);
            } else {
              await this.store.updateTaskStatus(task.id, targetStatus, undefined, result.error, errClass, result.error);
            }
          }
          return result;
        }),
      );

      processed += matching.length;

      // Update progress
      const currentJob = await this.store.getJob(jobId);
      if (currentJob) {
        const allTasks = await this.store.getTasksByJob(jobId);
        const completed = allTasks.filter((t) => t.status === 'succeeded').length;
        await this.store.updateJobProgress(jobId, completed, allTasks.length);
      }
    }

    return processed;
  }

  /** Extract source key from task kind (e.g. 'search:bitchute' → 'bitchute') */
  private extractSource(task: Task): string | null {
    if (task.kind.startsWith('search:')) return task.kind.replace('search:', '');
    if (task.kind === 'scrape_links') return 'youtube-web';
    if (task.kind === 'enrich') return 'youtube-api';
    return null;
  }

  /** Log a per-platform summary table at end of run. */
  private logRunSummary(tasks: Task[]): void {
    const searchTasks = tasks.filter(t => t.kind.startsWith('search:'));
    const byPlatform = new Map<string, Task[]>();
    for (const t of searchTasks) {
      const platform = t.kind.replace('search:', '');
      if (!byPlatform.has(platform)) byPlatform.set(platform, []);
      byPlatform.get(platform)!.push(t);
    }

    const lines: string[] = ['[orchestrator] Run summary:'];
    for (const [platform, pts] of byPlatform) {
      const succeeded = pts.filter(t => t.status === 'succeeded').length;
      const retryable = pts.filter(t => t.status === 'failed_retryable').length;
      const permanent = pts.filter(t => t.status === 'failed_permanent').length;
      const skipped = pts.filter(t => t.status === 'skipped').length;
      lines.push(`  ${platform}: ${succeeded} ok, ${retryable} retryable, ${permanent} permanent, ${skipped} skipped (${pts.length} total)`);
    }
    process.stderr.write(lines.join('\n') + '\n');
  }

  private createAdapters(config: PipelineConfig): Map<string, PlatformAdapter> {
    const adapters = new Map<string, PlatformAdapter>();

    if (config.platforms.includes('peertube')) {
      adapters.set(
        'peertube',
        new PeerTubeAdapter(
          config.peertubeInstances || ['search.joinpeertube.org'],
          this.cache,
          this.limiter,
        ),
      );
    }

    if (config.platforms.includes('odysee')) {
      adapters.set('odysee', new OdyseeAdapter(this.cache, this.limiter));
    }

    if (config.platforms.includes('dailymotion')) {
      adapters.set('dailymotion', new DailymotionAdapter(this.cache, this.limiter));
    }

    if (config.platforms.includes('bitchute')) {
      const bcConfig = {
        id: 'bitchute', name: 'BitChute', platformId: 'bitchute',
        sourceUrl: '', scriptUrl: '', contentHash: '', version: 1, packages: ['Http'],
      };
      adapters.set('bitchute', new GrayjayPluginAdapter(bcConfig, this.cache, this.limiter, 'bitchute'));
    }

    if (config.platforms.includes('rumble')) {
      const rmConfig = {
        id: 'rumble', name: 'Rumble', platformId: 'rumble',
        sourceUrl: '', scriptUrl: '', contentHash: '', version: 1, packages: ['Http', 'DOMParser'],
      };
      adapters.set('rumble', new GrayjayPluginAdapter(rmConfig, this.cache, this.limiter, 'rumble'));
    }

    return adapters;
  }
}
