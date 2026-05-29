import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getOrchestrator } from '$lib/server/orchestrator.js';
import type { ConfidenceTier } from '$lib/types';

// GET — retrieve current selections
export const GET: RequestHandler = async ({ params }) => {
  const orchestrator = getOrchestrator();
  const selections = await orchestrator.store.getSelections(params.id);
  return json({ selections });
};

// POST — save a selection
export const POST: RequestHandler = async ({ params, request }) => {
  const body = await request.json();
  const { channelId, platform, url, tier } = body as {
    channelId: string;
    platform: string;
    url: string;
    tier: ConfidenceTier;
  };

  if (!channelId || !platform || !url || !tier) {
    return json({ error: 'Missing required fields' }, { status: 400 });
  }

  const orchestrator = getOrchestrator();
  await orchestrator.store.setSelection(params.id, channelId, platform, url, tier);
  return json({ ok: true });
};

// DELETE — clear all selections
export const DELETE: RequestHandler = async ({ params }) => {
  const orchestrator = getOrchestrator();
  await orchestrator.store.clearSelections(params.id);
  return json({ ok: true });
};
