import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getOrchestrator } from '$lib/server/orchestrator.js';

// GET /api/jobs/:id — Job status + progress
export const GET: RequestHandler = async ({ params }) => {
  const orchestrator = await getOrchestrator();
  const job = await orchestrator.getJob(params.id);

  if (!job) {
    return json({ error: 'Job not found' }, { status: 404 });
  }

  // Compute per-platform progress from tasks
  const tasks = await orchestrator.store.getTasksByJob(params.id);
  const platformProgress: Record<string, { total: number; completed: number; failed: number; status: string }> = {};

  for (const task of tasks) {
    if (!task.kind.startsWith('search:')) continue;
    const platform = task.kind.replace('search:', '');
    if (!platformProgress[platform]) platformProgress[platform] = { total: 0, completed: 0, failed: 0, status: 'pending' };
    const pp = platformProgress[platform];
    pp.total++;
    if (task.status === 'succeeded') pp.completed++;
    else if (task.status === 'failed_permanent' || task.status === 'failed_retryable') pp.failed++;

    // Derive overall platform status
    if (pp.completed + pp.failed === pp.total && pp.failed > 0) pp.status = pp.completed === 0 ? 'failed' : 'partial';
    else if (pp.completed === pp.total) pp.status = 'complete';
    else if (pp.completed > 0 || pp.failed > 0) pp.status = 'running';
  }

  return json({ job, platformProgress });
};

// DELETE /api/jobs/:id — Delete a job and all its data
export const DELETE: RequestHandler = async ({ params }) => {
  const orchestrator = await getOrchestrator();

  try {
    await orchestrator.deleteJob(params.id);
    return json({ ok: true });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : 'Failed to delete job' },
      { status: 400 }
    );
  }
};
