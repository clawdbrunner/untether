import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getOrchestrator } from '$lib/server/orchestrator.js';

export const POST: RequestHandler = async ({ params }) => {
  const orchestrator = getOrchestrator();

  try {
    await orchestrator.resumeJob(params.id);
    const job = await orchestrator.getJob(params.id);
    return json({ job });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Failed to resume' }, { status: 400 });
  }
};
