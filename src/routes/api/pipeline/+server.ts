import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runPipeline } from '$lib/pipeline';
import type { PipelineConfig, ProgressEvent } from '$lib/types';

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

  const progressEvents: ProgressEvent[] = [];

  const config: PipelineConfig = {
    youtubeApiKey: apiKey,
    platforms,
    onProgress: (event) => {
      progressEvents.push(event);
    }
  };

  try {
    const result = await runPipeline(csv, config);
    return json({ result, progress: progressEvents });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Pipeline failed';
    return json({ error: message }, { status: 500 });
  }
};
