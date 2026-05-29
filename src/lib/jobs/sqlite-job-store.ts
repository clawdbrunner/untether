import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import type {
  Job,
  JobStatus,
  Task,
  TaskStatus,
  Selection,
  PipelineConfig,
  ConfidenceTier,
} from '../types.js';
import type { JobStore } from './interfaces.js';

const DEFAULT_DB_PATH = join(process.cwd(), '.cache', 'untether', 'jobs.db');
const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class SqliteJobStore implements JobStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? DEFAULT_DB_PATH;
    mkdirSync(dirname(path), { recursive: true });

    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        options_json TEXT NOT NULL,
        channel_ids_json TEXT NOT NULL,
        progress_completed INTEGER NOT NULL DEFAULT 0,
        progress_total INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        target_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        last_error TEXT,
        result_json TEXT,
        UNIQUE(job_id, kind, target_key)
      );

      CREATE TABLE IF NOT EXISTS selections (
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        chosen_url TEXT NOT NULL,
        tier TEXT NOT NULL,
        PRIMARY KEY (job_id, channel_id, platform)
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_job_status ON tasks(job_id, status);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
    `);
  }

  // --- Jobs ---

  async createJob(options: PipelineConfig, channelIds: string[]): Promise<Job> {
    const id = randomUUID();
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO jobs (id, created_at, status, options_json, channel_ids_json, progress_completed, progress_total)
      VALUES (?, ?, 'pending', ?, ?, 0, 0)
    `).run(id, now, JSON.stringify(options), JSON.stringify(channelIds));

    return {
      id,
      createdAt: now,
      status: 'pending',
      options,
      channelIds,
      progress: { completed: 0, total: 0 },
    };
  }

  async getJob(jobId: string): Promise<Job | null> {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
    return row ? this.rowToJob(row) : null;
  }

  async listJobs(status?: JobStatus): Promise<Job[]> {
    const rows = status
      ? this.db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC').all(status) as JobRow[]
      : this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all() as JobRow[];
    return rows.map(r => this.rowToJob(r));
  }

  async updateJobStatus(jobId: string, status: JobStatus): Promise<void> {
    this.db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, jobId);
  }

  async updateJobProgress(jobId: string, completed: number, total: number): Promise<void> {
    this.db.prepare('UPDATE jobs SET progress_completed = ?, progress_total = ? WHERE id = ?').run(completed, total, jobId);
  }

  async deleteJob(jobId: string): Promise<void> {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
  }

  // --- Tasks ---

  async createTasks(jobId: string, tasks: Omit<Task, 'id'>[]): Promise<Task[]> {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO tasks (id, job_id, kind, target_key, status, attempts, max_attempts, last_error, result_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result: Task[] = [];
    const insertAll = this.db.transaction((items: Omit<Task, 'id'>[]) => {
      for (const t of items) {
        const id = randomUUID();
        insert.run(id, jobId, t.kind, t.targetKey, t.status, t.attempts, t.maxAttempts, t.lastError ?? null, t.result ? JSON.stringify(t.result) : null);
        result.push({ ...t, id });
      }
    });
    insertAll(tasks);
    return result;
  }

  async getNextPendingTasks(jobId: string, limit: number): Promise<Task[]> {
    const rows = this.db.prepare(`
      SELECT * FROM tasks
      WHERE job_id = ? AND status = 'pending'
      ORDER BY kind, target_key
      LIMIT ?
    `).all(jobId, limit) as TaskRow[];
    return rows.map(r => this.rowToTask(r));
  }

  async getTasksByJob(jobId: string): Promise<Task[]> {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE job_id = ? ORDER BY kind, target_key').all(jobId) as TaskRow[];
    return rows.map(r => this.rowToTask(r));
  }

  async updateTaskStatus(taskId: string, status: TaskStatus, result?: unknown, error?: string): Promise<void> {
    const current = this.db.prepare('SELECT attempts FROM tasks WHERE id = ?').get(taskId) as { attempts: number } | undefined;
    const newAttempts = (current?.attempts ?? 0) + 1;

    this.db.prepare(`
      UPDATE tasks SET status = ?, attempts = ?, last_error = ?, result_json = ? WHERE id = ?
    `).run(status, newAttempts, error ?? null, result ? JSON.stringify(result) : null, taskId);
  }

  // --- Selections ---

  async setSelection(jobId: string, channelId: string, platform: string, url: string, tier: ConfidenceTier): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO selections (job_id, channel_id, platform, chosen_url, tier)
      VALUES (?, ?, ?, ?, ?)
    `).run(jobId, channelId, platform, url, tier);
  }

  async getSelections(jobId: string): Promise<Selection[]> {
    const rows = this.db.prepare('SELECT * FROM selections WHERE job_id = ?').all(jobId) as SelectionRow[];
    return rows.map(r => ({
      jobId: r.job_id,
      channelId: r.channel_id,
      platform: r.platform,
      chosenUrl: r.chosen_url,
      tier: r.tier as ConfidenceTier,
    }));
  }

  async clearSelections(jobId: string): Promise<void> {
    this.db.prepare('DELETE FROM selections WHERE job_id = ?').run(jobId);
  }

  // --- Cleanup ---

  async deleteJobsOlderThan(maxAge: number): Promise<number> {
    const cutoff = Date.now() - maxAge;
    const result = this.db.prepare('DELETE FROM jobs WHERE created_at < ? AND status != ?').run(cutoff, 'running');
    return result.changes;
  }

  // --- Lifecycle ---

  close(): void {
    this.db.close();
  }

  // --- Row mappers ---

  private rowToJob(row: JobRow): Job {
    return {
      id: row.id,
      createdAt: row.created_at,
      status: row.status as JobStatus,
      options: JSON.parse(row.options_json),
      channelIds: JSON.parse(row.channel_ids_json),
      progress: { completed: row.progress_completed, total: row.progress_total },
    };
  }

  private rowToTask(row: TaskRow): Task {
    return {
      id: row.id,
      jobId: row.job_id,
      kind: row.kind as Task['kind'],
      targetKey: row.target_key,
      status: row.status as TaskStatus,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      lastError: row.last_error ?? undefined,
      result: row.result_json ? JSON.parse(row.result_json) : undefined,
    };
  }
}

// Row types (snake_case from SQLite)
interface JobRow {
  id: string;
  created_at: number;
  status: string;
  options_json: string;
  channel_ids_json: string;
  progress_completed: number;
  progress_total: number;
}

interface TaskRow {
  id: string;
  job_id: string;
  kind: string;
  target_key: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  result_json: string | null;
}

interface SelectionRow {
  job_id: string;
  channel_id: string;
  platform: string;
  chosen_url: string;
  tier: string;
}
