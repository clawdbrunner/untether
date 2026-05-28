<script lang="ts">
	import type { PipelineResult } from '$lib/types';

	let { stats }: { stats: PipelineResult['stats'] } = $props();
</script>

<div class="stats-bar">
	<span class="stat"><span class="num">{stats.totalChannels}</span> channels</span>
	<span class="sep"></span>
	<span class="stat"><span class="num">{stats.enriched}</span> enriched</span>
	<span class="sep"></span>
	<span class="stat"><span class="num">{stats.declaredLinksFound}</span> links found</span>
	<span class="sep"></span>
	<span class="stat tier-verified"><span class="num">{stats.verifiedMatches}</span> verified</span>
	<span class="sep"></span>
	<span class="stat tier-likely"><span class="num">{stats.likelyMatches}</span> likely</span>
	<span class="sep"></span>
	<span class="stat tier-possible"><span class="num">{stats.possibleMatches}</span> possible</span>
	<span class="sep"></span>
	<span class="stat tier-weak"><span class="num">{stats.weakMatches}</span> weak</span>
</div>

<style>
	.stats-bar {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 16px;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 8px;
		flex-wrap: wrap;
	}

	.stat {
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	.num {
		font-weight: 700;
		color: var(--text-primary);
	}

	.tier-verified .num { color: var(--verified); }
	.tier-likely .num { color: var(--likely); }
	.tier-possible .num { color: var(--possible); }
	.tier-weak .num { color: var(--weak); }

	.sep {
		width: 1px;
		height: 16px;
		background: var(--border);
	}
</style>
