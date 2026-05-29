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

  return json({ job });
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
