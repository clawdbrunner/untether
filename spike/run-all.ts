/**
 * Run all spikes and report results.
 */

import { runSpike1 } from './01-yt-about-parser.js';
import { runSpike2 } from './02-peertube-search.js';
import { runSpike3 } from './03-odysee-search.js';
import { runSpike4 } from './04-ytdlp-enrichment.js';
import { runSpike5 } from './05-rate-limiter-cache.js';

const spikes = [
  { name: 'YouTube About Parser', fn: runSpike1 },
  { name: 'PeerTube Search', fn: runSpike2 },
  { name: 'Odysee/LBRY Search', fn: runSpike3 },
  { name: 'yt-dlp Enrichment', fn: runSpike4 },
  { name: 'Rate Limiter + Cache', fn: runSpike5 },
];

async function runAll() {
  console.log('🔬 Untether Spike Validation');
  console.log(`   Running ${spikes.length} spikes at ${new Date().toISOString()}`);

  const results: Array<{ name: string; status: 'PASS' | 'FAIL'; timeMs: number; error?: string }> = [];

  for (const spike of spikes) {
    console.log(`\n${'='.repeat(60)}`);
    const start = Date.now();
    try {
      await spike.fn();
      results.push({ name: spike.name, status: 'PASS', timeMs: Date.now() - start });
    } catch (e: any) {
      console.error(`\n❌ FAILED: ${spike.name}`, e.message || e);
      results.push({ name: spike.name, status: 'FAIL', timeMs: Date.now() - start, error: e.message });
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('\n📊 SPIKE RESULTS SUMMARY');
  console.log('─'.repeat(40));
  for (const r of results) {
    console.log(`  ${r.status === 'PASS' ? '✅' : '❌'} ${r.name} (${(r.timeMs / 1000).toFixed(1)}s)${r.error ? ` — ${r.error}` : ''}`);
  }
  console.log('─'.repeat(40));
  console.log(`  ${results.filter(r => r.status === 'PASS').length}/${results.length} spikes passed`);
  console.log(`  Total time: ${(results.reduce((s, r) => s + r.timeMs, 0) / 1000).toFixed(1)}s`);
}

runAll();
