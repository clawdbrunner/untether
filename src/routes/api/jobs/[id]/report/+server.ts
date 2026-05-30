import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getOrchestrator } from '$lib/server/orchestrator.js';
import { buildRunReport } from '$lib/jobs/run-report.js';

export const GET: RequestHandler = async ({ params }) => {
  const orchestrator = await getOrchestrator();
  const job = await orchestrator.getJob(params.id);

  if (!job) {
    return json({ error: 'Job not found' }, { status: 404 });
  }

  const tasks = await orchestrator.store.getTasksByJob(params.id);
  const report = buildRunReport(params.id, tasks);

  return json({ report });
};
