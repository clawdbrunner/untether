import type { YouTubeChannel } from '../types.js';

interface YouTubeApiChannelItem {
  id: string;
  snippet?: {
    description?: string;
    thumbnails?: { high?: { url?: string } };
  };
  statistics?: {
    subscriberCount?: string;
  };
}

interface YouTubeApiResponse {
  items?: YouTubeApiChannelItem[];
}

export async function batchEnrichChannels(
  channels: YouTubeChannel[],
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<Map<string, Partial<YouTubeChannel>>> {
  const result = new Map<string, Partial<YouTubeChannel>>();

  // Batch up to 50 IDs per call
  for (let i = 0; i < channels.length; i += 50) {
    const batch = channels.slice(i, i + 50);
    const ids = batch.map((c) => c.id).join(',');

    const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${ids}&key=${apiKey}`;

    try {
      const resp = await fetchFn(url, { signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) {
        console.error(`YouTube API error: ${resp.status} ${resp.statusText}`);
        continue;
      }

      const data: YouTubeApiResponse = await resp.json();
      if (!data.items) continue;

      for (const item of data.items) {
        const enriched: Partial<YouTubeChannel> = {};
        if (item.snippet?.description) enriched.description = item.snippet.description;
        if (item.snippet?.thumbnails?.high?.url) enriched.avatarUrl = item.snippet.thumbnails.high.url;
        if (item.statistics?.subscriberCount) {
          enriched.subscriberCount = parseInt(item.statistics.subscriberCount, 10);
        }
        result.set(item.id, enriched);
      }
    } catch (err) {
      console.error('YouTube API batch request failed:', err);
    }
  }

  return result;
}
