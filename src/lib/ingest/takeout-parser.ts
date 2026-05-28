import Papa from 'papaparse';
import type { YouTubeChannel } from '../types.js';

const HANDLE_RE = /youtube\.com\/@([^/?#]+)/i;
const CHANNEL_ID_RE = /youtube\.com\/channel\/(UC[a-zA-Z0-9_-]+)/i;

export function parseTakeoutCsv(csvText: string): YouTubeChannel[] {
  // Strip BOM
  const text = csvText.replace(/^\uFEFF/, '');

  // Check if first row looks like a header
  const firstLine = text.split(/\r?\n/)[0];
  const looksLikeHeader = /channel\s*id/i.test(firstLine);

  const parsed = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: true,
  });

  const rows = parsed.data;
  const startIdx = looksLikeHeader ? 1 : 0;

  const channels: YouTubeChannel[] = [];

  for (let i = startIdx; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 3) continue;

    const [id, url, title] = row.map((s) => s.trim());
    if (!id || !url || !title) continue;

    const channel: YouTubeChannel = { id, title, url };

    // Extract handle from URL
    const handleMatch = url.match(HANDLE_RE);
    if (handleMatch) {
      channel.handle = handleMatch[1];
    }

    channels.push(channel);
  }

  return channels;
}
