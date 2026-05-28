/**
 * Spike 4: yt-dlp Enrichment
 * Validates yt-dlp can extract channel metadata (directly or via Docker).
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const RESULTS_DIR = join(import.meta.dirname, 'results');
const TEST_CHANNEL = 'https://www.youtube.com/@LinusTechTips';

interface YtdlpResult {
  method: 'direct' | 'docker';
  version: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  fieldsExtracted: string[];
  missingFields: string[];
  timeMs: number;
  data?: Record<string, any>;
  error?: string;
  authRequired?: boolean;
}

function tryExec(cmd: string, timeoutMs = 30000): { stdout: string; error?: string } {
  try {
    const stdout = execSync(cmd, { timeout: timeoutMs, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { stdout: stdout.trim() };
  } catch (e: any) {
    return { stdout: e.stdout?.toString().trim() || '', error: e.stderr?.toString().trim() || e.message };
  }
}

function getVersion(): { hasDocker: boolean; hasYtdlp: boolean; dockerVersion: string; ytdlpVersion: string } {
  const docker = tryExec('docker --version');
  const ytdlp = tryExec('yt-dlp --version');
  return {
    hasDocker: !docker.error,
    hasYtdlp: !ytdlp.error,
    dockerVersion: docker.stdout || 'not available',
    ytdlpVersion: ytdlp.stdout || 'not available',
  };
}

const DESIRED_FIELDS = [
  'channel', 'channel_id', 'channel_url', 'uploader', 'uploader_id', 'uploader_url',
  'description', 'subscriber_count', 'view_count', 'thumbnails', 'tags',
];

function extractChannelDirect(): YtdlpResult {
  const start = Date.now();

  // Try extracting channel metadata with --dump-json on the channel page
  // Use --playlist-items 0 to skip video extraction, or --flat-playlist with limit
  const cmd = `yt-dlp -j --no-download --playlist-items 0 "${TEST_CHANNEL}" 2>&1 | head -50`;
  const result = tryExec(cmd, 45000);
  const elapsed = Date.now() - start;

  if (result.error && result.error.includes('cookies') || result.stdout.includes('Sign in')) {
    return {
      method: 'direct',
      version: tryExec('yt-dlp --version').stdout,
      status: 'FAILED',
      fieldsExtracted: [],
      missingFields: DESIRED_FIELDS,
      timeMs: elapsed,
      error: 'Authentication/cookies required',
      authRequired: true,
    };
  }

  // Try to parse the first JSON line
  const lines = (result.stdout || '').split('\n').filter(l => l.startsWith('{'));
  if (lines.length === 0) {
    // Try flat-playlist approach to get at least channel metadata from a video entry
    const flatCmd = `yt-dlp -j --flat-playlist --playlist-items 1 "${TEST_CHANNEL}/videos" 2>&1`;
    const flatResult = tryExec(flatCmd, 45000);
    const flatElapsed = Date.now() - start;

    const flatLines = (flatResult.stdout || '').split('\n').filter(l => l.startsWith('{'));
    if (flatLines.length === 0) {
      return {
        method: 'direct',
        version: tryExec('yt-dlp --version').stdout,
        status: 'FAILED',
        fieldsExtracted: [],
        missingFields: DESIRED_FIELDS,
        timeMs: flatElapsed,
        error: result.error || flatResult.error || 'No JSON output from yt-dlp',
        authRequired: (flatResult.error || '').includes('cookie') || (flatResult.stdout || '').includes('Sign in'),
      };
    }

    try {
      const data = JSON.parse(flatLines[0]);
      const found = DESIRED_FIELDS.filter(f => data[f] !== undefined);
      const missing = DESIRED_FIELDS.filter(f => data[f] === undefined);

      // Extract just the interesting fields
      const extracted: Record<string, any> = {};
      for (const key of [...found, 'title', 'id', 'webpage_url']) {
        if (data[key] !== undefined) {
          extracted[key] = typeof data[key] === 'string' ? data[key].substring(0, 200) : data[key];
        }
      }

      return {
        method: 'direct',
        version: tryExec('yt-dlp --version').stdout,
        status: found.length >= 5 ? 'SUCCESS' : 'PARTIAL',
        fieldsExtracted: found,
        missingFields: missing,
        timeMs: flatElapsed,
        data: extracted,
      };
    } catch {
      return {
        method: 'direct',
        version: tryExec('yt-dlp --version').stdout,
        status: 'FAILED',
        fieldsExtracted: [],
        missingFields: DESIRED_FIELDS,
        timeMs: flatElapsed,
        error: 'Could not parse yt-dlp JSON output',
      };
    }
  }

  try {
    const data = JSON.parse(lines[0]);
    const found = DESIRED_FIELDS.filter(f => data[f] !== undefined);
    const missing = DESIRED_FIELDS.filter(f => data[f] === undefined);

    const extracted: Record<string, any> = {};
    for (const key of [...found, 'title', 'id', 'webpage_url']) {
      if (data[key] !== undefined) {
        extracted[key] = typeof data[key] === 'string' ? data[key].substring(0, 200) : data[key];
      }
    }

    return {
      method: 'direct',
      version: tryExec('yt-dlp --version').stdout,
      status: found.length >= 5 ? 'SUCCESS' : 'PARTIAL',
      fieldsExtracted: found,
      missingFields: missing,
      timeMs: elapsed,
      data: extracted,
    };
  } catch {
    return {
      method: 'direct',
      version: tryExec('yt-dlp --version').stdout,
      status: 'FAILED',
      fieldsExtracted: [],
      missingFields: DESIRED_FIELDS,
      timeMs: elapsed,
      error: 'Could not parse yt-dlp JSON output',
    };
  }
}

export async function runSpike4(): Promise<void> {
  console.log('\n=== Spike 4: yt-dlp Enrichment ===');

  const env = getVersion();
  console.log(`  Docker: ${env.hasDocker ? env.dockerVersion : 'not available'}`);
  console.log(`  yt-dlp: ${env.hasYtdlp ? env.ytdlpVersion : 'not available'}`);

  if (!env.hasYtdlp && !env.hasDocker) {
    console.log('  ❌ Neither yt-dlp nor Docker available — spike cannot run');
    writeFileSync(join(RESULTS_DIR, 'ytdlp-channel-output.json'), JSON.stringify({ error: 'No yt-dlp or Docker' }, null, 2));
    return;
  }

  let result: YtdlpResult;

  if (env.hasYtdlp) {
    console.log(`\n  Testing direct yt-dlp on ${TEST_CHANNEL}...`);
    result = extractChannelDirect();
  } else {
    // Docker fallback — build and run
    console.log('\n  Building Docker image...');
    const buildResult = tryExec('docker build -t untether-ytdlp -f - . <<EOF\nFROM python:3.12-slim\nRUN pip install yt-dlp\nENTRYPOINT ["yt-dlp"]\nEOF', 120000);
    if (buildResult.error) {
      console.log(`  ❌ Docker build failed: ${buildResult.error}`);
      result = {
        method: 'docker',
        version: 'unknown',
        status: 'FAILED',
        fieldsExtracted: [],
        missingFields: DESIRED_FIELDS,
        timeMs: 0,
        error: `Docker build failed: ${buildResult.error}`,
      };
    } else {
      const start = Date.now();
      const cmd = `docker run --rm untether-ytdlp -j --flat-playlist --playlist-items 1 "${TEST_CHANNEL}/videos" 2>&1`;
      const dockerResult = tryExec(cmd, 60000);
      result = {
        method: 'docker',
        version: 'docker',
        status: dockerResult.error ? 'FAILED' : 'PARTIAL',
        fieldsExtracted: [],
        missingFields: DESIRED_FIELDS,
        timeMs: Date.now() - start,
        error: dockerResult.error,
      };
    }
  }

  console.log(`\n  Channel extraction test (${TEST_CHANNEL}):`);
  console.log(`    Status: ${result.status}`);
  console.log(`    Method: ${result.method}`);
  console.log(`    Time: ${(result.timeMs / 1000).toFixed(1)}s`);
  if (result.fieldsExtracted.length > 0) {
    console.log(`    Fields extracted: [${result.fieldsExtracted.join(', ')}]`);
  }
  if (result.missingFields.length > 0) {
    console.log(`    Missing fields: [${result.missingFields.join(', ')}]`);
  }
  if (result.error) {
    console.log(`    Error: ${result.error}`);
  }
  if (result.authRequired) {
    console.log(`    ⚠️  Auth cookies may be required for full channel metadata`);
  }

  writeFileSync(join(RESULTS_DIR, 'ytdlp-channel-output.json'), JSON.stringify(result, null, 2));
  console.log(`  Results saved to spike/results/ytdlp-channel-output.json`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('04-ytdlp-enrichment.ts')) {
  runSpike4();
}
