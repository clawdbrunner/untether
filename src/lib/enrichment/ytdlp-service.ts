import { execFile } from 'child_process';
import type { YouTubeChannel } from '../types.js';
import type { RateLimiter } from '../rate-limit/rate-limiter.js';

interface YtdlpOutput {
  channel?: string;
  channel_id?: string;
  channel_url?: string;
  channel_follower_count?: number;
  description?: string;
  thumbnails?: Array<{ url: string; width?: number; height?: number }>;
  uploader?: string;
  uploader_url?: string;
  uploader_id?: string;
}

export async function ytdlpEnrich(
  channelUrl: string,
  opts?: { timeout?: number },
  limiter?: RateLimiter,
): Promise<Partial<YouTubeChannel> | null> {
  const timeout = opts?.timeout ?? 30_000;

  // Try --dump-single-json first (best for channel-level data)
  let json = await runYtdlp(
    ['--dump-single-json', '--flat-playlist', '--playlist-items', '0', channelUrl],
    timeout,
  );

  // Fallback: get first video which includes channel info
  if (!json) {
    json = await runYtdlp(
      ['-j', '--no-download', '--playlist-items', '1', `${channelUrl}/videos`],
      timeout,
    );
  }

  if (!json) {
    limiter?.reportFailure('youtube-web');
    return null;
  }

  limiter?.reportSuccess('youtube-web');

  const result: Partial<YouTubeChannel> = {};

  if (json.description) result.description = json.description;
  if (json.channel_follower_count != null) result.subscriberCount = json.channel_follower_count;

  // Find the best avatar thumbnail
  if (json.thumbnails && json.thumbnails.length > 0) {
    // Pick the largest thumbnail that looks like an avatar (square-ish) or just the first
    const sorted = [...json.thumbnails].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
    result.avatarUrl = sorted[0].url;
  }

  // Extract handle from uploader_url (e.g., "https://www.youtube.com/@LinusTechTips" → "@LinusTechTips")
  if (json.uploader_url) {
    const handleMatch = json.uploader_url.match(/\/@([^/?#]+)/);
    if (handleMatch) {
      result.handle = `@${handleMatch[1]}`;
    }
  }

  // Fallback: try uploader_id if it looks like a handle
  if (!result.handle && json.uploader_id && json.uploader_id.startsWith('@')) {
    result.handle = json.uploader_id;
  }

  return result;
}

function runYtdlp(args: string[], timeout: number): Promise<YtdlpOutput | null> {
  return new Promise((resolve) => {
    try {
      execFile('yt-dlp', args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        try {
          // yt-dlp may output multiple JSON objects for playlists; take the first line
          const firstLine = stdout.trim().split('\n')[0];
          resolve(JSON.parse(firstLine));
        } catch {
          resolve(null);
        }
      });
    } catch {
      // yt-dlp not installed
      resolve(null);
    }
  });
}
