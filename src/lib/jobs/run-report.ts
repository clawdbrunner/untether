import type { Task, ErrorClass, MatchResult } from '../types.js';
import { getUserFacingMessage } from './error-classifier.js';

export interface PlatformSummary {
  platform: string;
  total: number;
  succeeded: number;
  matched: number;
  zeroResult: number;
  failedRetryable: number;
  failedPermanent: number;
  skipped: number;
  circuitBreakerTripped: boolean;
  errorsByClass: Partial<Record<ErrorClass, number>>;
  errorDetails: Array<{ errorClass: ErrorClass; detail: string; count: number }>;
  userMessage?: string;
}

export interface RunReport {
  jobId: string;
  totalTasks: number;
  totalSucceeded: number;
  totalFailed: number;
  totalSkipped: number;
  platforms: PlatformSummary[];
}

export function buildRunReport(jobId: string, tasks: Task[]): RunReport {
  const searchTasks = tasks.filter(t => t.kind.startsWith('search:'));
  const byPlatform = new Map<string, Task[]>();

  for (const t of searchTasks) {
    const platform = t.kind.replace('search:', '');
    if (!byPlatform.has(platform)) byPlatform.set(platform, []);
    byPlatform.get(platform)!.push(t);
  }

  const platforms: PlatformSummary[] = [];

  for (const [platform, pts] of byPlatform) {
    const succeeded = pts.filter(t => t.status === 'succeeded');
    const matched = succeeded.filter(t => {
      const result = t.result as MatchResult | undefined;
      return result && result.candidates && result.candidates.length > 0;
    });
    const zeroResult = succeeded.length - matched.length;

    const failedRetryable = pts.filter(t => t.status === 'failed_retryable');
    const failedPermanent = pts.filter(t => t.status === 'failed_permanent');
    const skipped = pts.filter(t => t.status === 'skipped');

    // Count errors by class
    const errorsByClass: Partial<Record<ErrorClass, number>> = {};
    const detailCounts = new Map<string, { errorClass: ErrorClass; detail: string; count: number }>();

    for (const t of [...failedRetryable, ...failedPermanent, ...skipped]) {
      const ec = t.lastErrorClass ?? 'transient';
      errorsByClass[ec] = (errorsByClass[ec] ?? 0) + 1;

      const detail = t.lastErrorDetail ?? t.lastError ?? 'Unknown';
      const key = `${ec}:${detail}`;
      const existing = detailCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        detailCounts.set(key, { errorClass: ec, detail, count: 1 });
      }
    }

    const circuitBreakerTripped = skipped.some(t => t.lastErrorDetail === 'Circuit breaker open');

    // Pick the dominant error class for user-facing message
    let userMessage: string | undefined;
    const failedTotal = failedRetryable.length + failedPermanent.length + skipped.length;
    if (failedTotal > 0) {
      const dominantClass = Object.entries(errorsByClass)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0]?.[0] as ErrorClass | undefined;
      if (dominantClass) {
        userMessage = getUserFacingMessage(dominantClass, platform);
      }
    }

    platforms.push({
      platform,
      total: pts.length,
      succeeded: succeeded.length,
      matched: matched.length,
      zeroResult,
      failedRetryable: failedRetryable.length,
      failedPermanent: failedPermanent.length,
      skipped: skipped.length,
      circuitBreakerTripped,
      errorsByClass,
      errorDetails: Array.from(detailCounts.values()).sort((a, b) => b.count - a.count),
      userMessage,
    });
  }

  const totalSucceeded = platforms.reduce((s, p) => s + p.succeeded, 0);
  const totalFailed = platforms.reduce((s, p) => s + p.failedRetryable + p.failedPermanent, 0);
  const totalSkipped = platforms.reduce((s, p) => s + p.skipped, 0);

  return {
    jobId,
    totalTasks: searchTasks.length,
    totalSucceeded,
    totalFailed,
    totalSkipped,
    platforms,
  };
}
