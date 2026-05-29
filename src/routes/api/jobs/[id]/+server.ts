import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getOrchestrator } from '$lib/server/orchestrator.js';

// GET /api/jobs/:id — Job status + progress
export const GET: RequestHandler = async ({ params }) => {
  const orchestrator = getOrchestrator();
  const job = await orchestrator.getJob(params.id);

  if (!job) {
    return json({ error: 'Job not found' }, { status: 404 });
  }

  return json({ job });
};
