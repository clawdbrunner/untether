import type { Task } from '../types.js';
import type { TaskQueue } from './interfaces.js';
import type { SqliteJobStore } from './sqlite-job-store.js';

export class SqliteTaskQueue implements TaskQueue {
  constructor(private store: SqliteJobStore, private jobId: string) {}

  async enqueue(_tasks: Task[]): Promise<void> {
    // Tasks are already in the store — just ensure they're pending
    // This is a no-op for SQLite since tasks are created directly
  }

  async dequeue(limit: number): Promise<Task[]> {
    return this.store.getNextPendingTasks(this.jobId, limit);
  }

  async complete(taskId: string, result: unknown): Promise<void> {
    await this.store.updateTaskStatus(taskId, 'completed', result);
  }

  async fail(taskId: string, error: string): Promise<void> {
    await this.store.updateTaskStatus(taskId, 'failed', undefined, error);
  }

  async pendingCount(): Promise<number> {
    const tasks = await this.store.getNextPendingTasks(this.jobId, 9999);
    return tasks.length;
  }
}
