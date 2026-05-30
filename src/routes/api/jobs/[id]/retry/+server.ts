import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getOrchestrator } from '$lib/server/orchestrator.js';

export const POST: RequestHandler = async ({ params }) => {
  const orchestrator = await getOrchestrator();

  try {
    const count = await orchestrator.retryFailed(params.id);
    return json({ retriedCount: count });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : 'Failed to retry' },
      { status: 400 },
    );
  }
};
