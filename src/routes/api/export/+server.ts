import type { RequestHandler } from './$types';

interface ExportSelection {
  channelTitle: string;
  platform: string;
  url: string;
  tier: string;
  score: number;
}

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json();
  const { selections, format } = body as {
    selections: ExportSelection[];
    format: 'txt' | 'newpipe' | 'csv';
  };

  if (!selections?.length || !format) {
    return new Response('Missing selections or format', { status: 400 });
  }

  let content: string;
  let filename: string;
  let mime: string;

  switch (format) {
    case 'txt': {
      const date = new Date().toISOString().split('T')[0];
      const lines: string[] = [`# Untether Export — generated ${date}`];
      const byPlatform = new Map<string, ExportSelection[]>();
      for (const s of selections) {
        if (!byPlatform.has(s.platform)) byPlatform.set(s.platform, []);
        byPlatform.get(s.platform)!.push(s);
      }
      for (const [platform, entries] of byPlatform) {
        const label = platform === 'peertube' ? 'PeerTube' : 'Odysee';
        lines.push(`# ${label} (${entries.length} channels)`);
        for (const e of entries) lines.push(e.url);
      }
      content = lines.join('\n') + '\n';
      filename = 'untether-export.txt';
      mime = 'text/plain';
      break;
    }

    case 'newpipe': {
      const ptEntries = selections.filter((s) => s.platform === 'peertube');
      const subs = ptEntries.map((s) => ({
        service_id: 4,
        url: s.url,
        name: s.channelTitle,
      }));
      content = JSON.stringify(
        { app_version: '0.27.0', app_version_int: 998, subscriptions: subs },
        null,
        2,
      );
      filename = 'untether-newpipe.json';
      mime = 'application/json';
      break;
    }

    case 'csv': {
      const header = 'channel,platform,url,tier,score';
      const rows = selections.map(
        (s) =>
          `"${s.channelTitle.replace(/"/g, '""')}",${s.platform},${s.url},${s.tier},${Math.round(s.score * 100)}`,
      );
      content = [header, ...rows].join('\n') + '\n';
      filename = 'untether-export.csv';
      mime = 'text/csv';
      break;
    }
  }

  return new Response(content, {
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
};
