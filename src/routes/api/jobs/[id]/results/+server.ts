import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getOrchestrator } from '$lib/server/orchestrator.js';

export const GET: RequestHandler = async ({ params }) => {
  const orchestrator = await getOrchestrator();
  const result = await orchestrator.getJobResults(params.id);

  if (!result) {
    return json({ error: 'Job not found or no results' }, { status: 404 });
  }

  return json({ result });
};
