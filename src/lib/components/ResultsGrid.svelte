<script lang="ts">
	import type { PipelineResult, MatchResult, ConfidenceTier } from '$lib/types';
	import ChannelRow from './ChannelRow.svelte';
	import StatsBar from './StatsBar.svelte';

	let {
		result,
		selections,
		selectedIndices,
		onaccept,
		onskip,
		onselectcandidate,
		onbulkaction
	}: {
		result: PipelineResult;
		selections: Map<string, Map<string, string>>;
		selectedIndices: Map<string, Map<string, number>>;
		onaccept: (channelId: string, platform: string) => void;
		onskip: (channelId: string, platform: string) => void;
		onselectcandidate: (channelId: string, platform: string, index: number) => void;
		onbulkaction: (action: string) => void;
	} = $props();

	let tierFilter = $state<'all' | ConfidenceTier | 'likely+' | 'possible+'>('all');
	let searchQuery = $state('');
	let sortBy = $state<'name' | 'tier' | 'subs'>('name');

	let platforms = $derived(
		[...new Set(result.matches.map((m) => m.platform))].sort()
	);

	// Group matches by channel
	let channelMatches = $derived(() => {
		const map = new Map<string, Map<string, MatchResult>>();
		for (const match of result.matches) {
			const chId = match.youtubeChannel.id;
			if (!map.has(chId)) map.set(chId, new Map());
			map.get(chId)!.set(match.platform, match);
		}
		return map;
	});

	const tierRank: Record<ConfidenceTier, number> = {
		verified: 4,
		likely: 3,
		possible: 2,
		weak: 1
	};

	function getBestTier(channelId: string): number {
		const matches = channelMatches().get(channelId);
		if (!matches) return 0;
		let best = 0;
		for (const m of matches.values()) {
			const top = m.candidates[0];
			if (top) best = Math.max(best, tierRank[top.tier]);
		}
		return best;
	}

	function passesFilter(channelId: string): boolean {
		if (tierFilter === 'all') return true;
		const best = getBestTier(channelId);
		if (tierFilter === 'likely+') return best >= 3;
		if (tierFilter === 'possible+') return best >= 2;
		return best === tierRank[tierFilter as ConfidenceTier];
	}

	let filteredChannels = $derived(() => {
		let channels = result.channels.filter((ch) => {
			if (!passesFilter(ch.id)) return false;
			if (searchQuery) {
				const q = searchQuery.toLowerCase();
				return (
					ch.title.toLowerCase().includes(q) ||
					(ch.handle?.toLowerCase().includes(q) ?? false)
				);
			}
			return true;
		});

		channels.sort((a, b) => {
			if (sortBy === 'name') return a.title.localeCompare(b.title);
			if (sortBy === 'subs') return (b.subscriberCount ?? 0) - (a.subscriberCount ?? 0);
			if (sortBy === 'tier') return getBestTier(b.id) - getBestTier(a.id);
			return 0;
		});

		return channels;
	});

	let selectedCount = $derived(() => {
		let count = 0;
		for (const platformMap of selections.values()) {
			count += platformMap.size;
		}
		return count;
	});
</script>

<div class="results-grid">
	<StatsBar stats={result.stats} />

	<div class="toolbar">
		<div class="filters">
			<input
				type="text"
				class="search-input"
				placeholder="Search channels..."
				bind:value={searchQuery}
			/>

			<select class="filter-select" bind:value={tierFilter}>
				<option value="all">All tiers</option>
				<option value="verified">Verified only</option>
				<option value="likely+">Likely+</option>
				<option value="possible+">Possible+</option>
				<option value="verified">Verified</option>
				<option value="likely">Likely</option>
				<option value="possible">Possible</option>
				<option value="weak">Weak</option>
			</select>

			<select class="sort-select" bind:value={sortBy}>
				<option value="name">Sort: Name</option>
				<option value="tier">Sort: Confidence</option>
				<option value="subs">Sort: Subscribers</option>
			</select>
		</div>

		<div class="bulk-actions">
			<button class="bulk-btn" onclick={() => onbulkaction('accept-verified')}>
				Accept all Verified
			</button>
			<button class="bulk-btn" onclick={() => onbulkaction('accept-likely')}>
				Accept all &ge; Likely
			</button>
			<button class="bulk-btn btn-clear" onclick={() => onbulkaction('clear')}>
				Clear all
			</button>
			<span class="selection-count">{selectedCount()} selected</span>
		</div>
	</div>

	<div class="grid-header" style="--platform-count:{platforms.length}">
		<div class="header-cell yt-header">YouTube Channel</div>
		{#each platforms as platform}
			<div class="header-cell platform-header">{platform === 'peertube' ? 'PeerTube' : platform === 'odysee' ? 'Odysee' : platform === 'dailymotion' ? 'Dailymotion' : platform === 'bitchute' ? 'BitChute' : platform === 'rumble' ? 'Rumble' : platform}</div>
		{/each}
	</div>

	<div class="grid-body" style="--platform-count:{platforms.length}">
		{#each filteredChannels() as channel (channel.id)}
			<ChannelRow
				{channel}
				{platforms}
				matchesByPlatform={channelMatches().get(channel.id) ?? new Map()}
				selections={selections.get(channel.id) ?? new Map()}
				selectedIndices={selectedIndices.get(channel.id) ?? new Map()}
				onaccept={(p) => onaccept(channel.id, p)}
				onskip={(p) => onskip(channel.id, p)}
				onselectcandidate={(p, i) => onselectcandidate(channel.id, p, i)}
			/>
		{/each}

		{#if filteredChannels().length === 0}
			<div class="empty-state">
				<p>No channels match the current filter.</p>
			</div>
		{/if}
	</div>
</div>

<style>
	.results-grid {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.toolbar {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		align-items: center;
		justify-content: space-between;
	}

	.filters {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.search-input {
		padding: 8px 12px;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--text-primary);
		font-size: 0.85rem;
		width: 200px;
	}

	.search-input:focus {
		outline: none;
		border-color: var(--accent);
	}

	.filter-select,
	.sort-select {
		padding: 8px 12px;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--text-primary);
		font-size: 0.85rem;
		cursor: pointer;
	}

	.bulk-actions {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
	}

	.bulk-btn {
		padding: 6px 12px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--text-secondary);
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.15s;
	}

	.bulk-btn:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.btn-clear {
		color: var(--text-muted);
	}

	.btn-clear:hover {
		color: var(--danger);
		border-color: var(--danger);
	}

	.selection-count {
		font-size: 0.8rem;
		color: var(--text-muted);
		font-weight: 600;
	}

	.grid-header {
		display: grid;
		grid-template-columns: 240px repeat(var(--platform-count, 2), 1fr);
		gap: 12px;
		padding: 10px 0;
		border-bottom: 2px solid var(--border);
		position: sticky;
		top: 0;
		background: var(--bg-primary);
		z-index: 10;
	}

	.header-cell {
		font-weight: 700;
		font-size: 0.85rem;
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.grid-body {
		display: flex;
		flex-direction: column;
	}

	.empty-state {
		text-align: center;
		padding: 40px;
		color: var(--text-muted);
		font-size: 0.9rem;
	}

	@media (max-width: 768px) {
		.grid-header {
			display: none;
		}

		.toolbar {
			flex-direction: column;
			align-items: stretch;
		}

		.filters {
			flex-direction: column;
		}

		.search-input {
			width: 100%;
		}
	}
</style>
