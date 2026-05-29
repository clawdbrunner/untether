import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getOrchestrator } from '$lib/server/orchestrator.js';

// POST /api/jobs — Create and start a new job
export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json();
  const { csv, platforms, apiKey } = body as {
    csv: string;
    platforms: ('peertube' | 'odysee')[];
    apiKey?: string;
  };

  if (!csv || !platforms?.length) {
    return json({ error: 'Missing csv or platforms' }, { status: 400 });
  }

  const orchestrator = getOrchestrator();

  const job = await orchestrator.createJob(csv, {
    youtubeApiKey: apiKey,
    platforms,
  });

  // Start immediately
  await orchestrator.startJob(job.id);

  return json({ jobId: job.id, status: 'running' });
};

// GET /api/jobs — List all jobs
export const GET: RequestHandler = async () => {
  const orchestrator = getOrchestrator();
  const jobs = await orchestrator.store.listJobs();
  return json({ jobs });
};
