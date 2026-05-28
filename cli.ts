#!/usr/bin/env npx tsx
/**
 * Untether CLI — run the full pipeline from a Takeout CSV.
 *
 * Usage:
 *   npx tsx cli.ts --csv subscriptions.csv [--api-key YOUTUBE_API_KEY] [--platforms peertube,odysee]
 */
import { readFileSync, writeFileSync } from 'fs';
import { runPipeline } from './src/lib/pipeline.js';

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const csvPath = getArg('--csv');
if (!csvPath) {
  console.error('Usage: npx tsx cli.ts --csv <path-to-subscriptions.csv> [--api-key KEY] [--platforms peertube,odysee]');
  process.exit(1);
}

const apiKey = getArg('--api-key');
const platformsArg = getArg('--platforms');
const platforms = platformsArg
  ? platformsArg.split(',') as ('peertube' | 'odysee')[]
  : ['peertube', 'odysee'] as ('peertube' | 'odysee')[];

const csv = readFileSync(csvPath, 'utf-8');

console.log(`\nUntether — Cross-Platform Creator Finder`);
console.log(`Platforms: ${platforms.join(', ')}`);
console.log(`API key: ${apiKey ? 'provided' : 'not provided (yt-dlp fallback)'}\n`);

const result = await runPipeline(csv, {
  youtubeApiKey: apiKey,
  platforms,
  onProgress: (e) => {
    console.log(`[${e.phase}] ${e.current}/${e.total} — ${e.message}`);
  },
});

// Print results table
console.log('\n=== RESULTS ===\n');
for (const match of result.matches) {
  const top = match.candidates[0];
  const name = match.youtubeChannel.title;
  if (top) {
    console.log(`${name} → ${match.platform}: ${top.candidate.displayName} [${top.tier.toUpperCase()}] (${(top.score * 100).toFixed(0)}%)`);
    for (const s of top.signals) {
      console.log(`  \u2022 ${s.type}: ${s.detail}`);
    }
  } else {
    console.log(`${name} → ${match.platform}: No matches found`);
  }
}

// Print stats
console.log('\n=== STATS ===');
console.log(JSON.stringify(result.stats, null, 2));

// Save results
writeFileSync('pipeline-results.json', JSON.stringify(result, null, 2));
console.log('\nFull results saved to pipeline-results.json');
