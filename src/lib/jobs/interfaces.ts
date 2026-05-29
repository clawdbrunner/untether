import type {
  Job,
  JobStatus,
  Task,
  TaskStatus,
  Selection,
  PipelineConfig,
  ConfidenceTier,
} from '../types.js';

/**
 * JobStore — per-run, sensitive, short TTL (§9.5b).
 * Self-host: SQLite. Cloudflare: D1 (future).
 */
export interface JobStore {
  // Jobs
  createJob(options: PipelineConfig, channelIds: string[]): Promise<Job>;
  getJob(jobId: string): Promise<Job | null>;
  listJobs(status?: JobStatus): Promise<Job[]>;
  updateJobStatus(jobId: string, status: JobStatus): Promise<void>;
  updateJobProgress(jobId: string, completed: number, total: number): Promise<void>;
  deleteJob(jobId: string): Promise<void>;

  // Tasks
  createTasks(jobId: string, tasks: Omit<Task, 'id'>[]): Promise<Task[]>;
  getNextPendingTasks(jobId: string, limit: number): Promise<Task[]>;
  getTasksByJob(jobId: string): Promise<Task[]>;
  updateTaskStatus(taskId: string, status: TaskStatus, result?: unknown, error?: string): Promise<void>;

  // Selections (user-confirmed matches)
  setSelection(jobId: string, channelId: string, platform: string, url: string, tier: ConfidenceTier): Promise<void>;
  getSelections(jobId: string): Promise<Selection[]>;
  clearSelections(jobId: string): Promise<void>;

  // Cleanup
  deleteJobsOlderThan(maxAge: number): Promise<number>;

  // Lifecycle
  close(): void;
}

/**
 * TaskQueue — schedules work respecting rate limits.
 * In-process loop for self-host. Cloudflare Queues (future).
 */
export interface TaskQueue {
  enqueue(tasks: Task[]): Promise<void>;
  dequeue(limit: number): Promise<Task[]>;
  complete(taskId: string, result: unknown): Promise<void>;
  fail(taskId: string, error: string): Promise<void>;
  pendingCount(): number;
}
