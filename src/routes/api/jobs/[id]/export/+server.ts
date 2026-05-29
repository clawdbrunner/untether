import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getOrchestrator } from '$lib/server/orchestrator.js';

export const POST: RequestHandler = async ({ params, request }) => {
  const body = await request.json();
  const { format } = body as { format: 'txt' | 'newpipe' | 'csv' };

  const orchestrator = await getOrchestrator();
  const result = await orchestrator.getJobResults(params.id);
  if (!result) {
    return json({ error: 'Job not found' }, { status: 404 });
  }

  const selections = await orchestrator.store.getSelections(params.id);

  // Generate export based on format
  const entries = selections.map(s => ({
    channelTitle: result.channels.find(c => c.id === s.channelId)?.title ?? s.channelId,
    platform: s.platform,
    url: s.chosenUrl,
    tier: s.tier,
  }));

  let content: string;
  let filename: string;
  let mimeType: string;

  switch (format) {
    case 'txt': {
      const date = new Date().toISOString().split('T')[0];
      const lines = [`# Untether Export — generated ${date}`];
      const byPlatform = new Map<string, typeof entries>();
      for (const e of entries) {
        const arr = byPlatform.get(e.platform) ?? [];
        arr.push(e);
        byPlatform.set(e.platform, arr);
      }
      for (const [platform, items] of byPlatform) {
        lines.push(`# ${platform} (${items.length} channels)`);
        for (const item of items) lines.push(item.url);
        lines.push('');
      }
      content = lines.join('\n');
      filename = `untether-export-${date}.txt`;
      mimeType = 'text/plain';
      break;
    }
    case 'newpipe': {
      const ptEntries = entries.filter(e => e.platform === 'peertube');
      const subscriptions = ptEntries.map(e => ({
        service_id: 4,
        url: e.url,
        name: e.channelTitle,
      }));
      content = JSON.stringify({
        app_version: '0.27.0',
        app_version_int: 998,
        subscriptions,
      }, null, 2);
      filename = 'untether-newpipe.json';
      mimeType = 'application/json';
      break;
    }
    case 'csv': {
      const header = 'channel,platform,url,tier,score';
      const rows = entries.map(e =>
        `"${e.channelTitle.replace(/"/g, '""')}",${e.platform},${e.url},${e.tier},100`
      );
      content = [header, ...rows].join('\n') + '\n';
      filename = 'untether-export.csv';
      mimeType = 'text/csv';
      break;
    }
    default:
      return json({ error: 'Invalid format' }, { status: 400 });
  }

  return new Response(content, {
    headers: {
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
};
