<script lang="ts">
	import type { ScoredCandidate, ConfidenceTier } from '$lib/types';
	import TierBadge from './TierBadge.svelte';
	import AvatarCompare from './AvatarCompare.svelte';

	let {
		candidates,
		youtubeAvatarUrl,
		channelName = '',
		accepted = false,
		selectedIndex = 0,
		onaccept,
		onskip,
		onselect
	}: {
		candidates: ScoredCandidate[];
		youtubeAvatarUrl?: string;
		channelName?: string;
		accepted: boolean;
		selectedIndex: number;
		onaccept: () => void;
		onskip: () => void;
		onselect: (index: number) => void;
	} = $props();

	let expanded = $state(false);

	let top = $derived(candidates[selectedIndex] ?? candidates[0]);
	let hasCandidate = $derived(candidates.length > 0 && top != null);
	let scorePercent = $derived(hasCandidate ? Math.round(top.score * 100) : 0);

	const signalLabels: Record<string, string> = {
		declared_link: 'link',
		back_reference: 'back-ref',
		name_match: 'name',
		avatar_hash: 'avatar',
		handle_match: 'handle'
	};

	function formatSubs(n?: number): string {
		if (n == null) return '';
		if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
		if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
		return n.toString();
	}
</script>

{#if !hasCandidate}
	<div class="cell empty">
		<span class="no-match">— No match —</span>
	</div>
{:else}
	<div class="cell" class:accepted class:expanded>
		<div class="cell-main">
			<div class="cell-header">
				<div class="avatars">
					<AvatarCompare
						youtubeUrl={youtubeAvatarUrl}
						candidateUrl={top.candidate.avatarUrl}
						channelName={channelName}
					/>
					{#if top.signals.find(s => s.type === 'avatar_hash')}
						<span class="avatar-signal">
							👤 {Math.round(top.signals.find(s => s.type === 'avatar_hash')!.strength * 100)}%
						</span>
					{/if}
				</div>
				<div class="info">
					<div class="name-row">
						<TierBadge tier={top.tier} />
						<span class="candidate-name">{top.candidate.displayName}</span>
					</div>
					{#if top.candidate.handle}
						<span class="handle">@{top.candidate.handle}</span>
					{/if}
				</div>
			</div>

			<div class="score-row">
				<div class="score-bar">
					<div class="score-fill" style="width:{scorePercent}%"></div>
				</div>
				<span class="score-label">{scorePercent}%</span>
				{#if top.candidate.subscriberCount}
					<span class="subs">{formatSubs(top.candidate.subscriberCount)} subs</span>
				{/if}
			</div>

			{#if top.signals.length > 0}
				<div class="signals">
					{#each top.signals as signal}
						<span
							class="signal-pill"
							class:avatar-signal-pill={signal.type === 'avatar_hash'}
						>
							{signalLabels[signal.type] ?? signal.type}
						</span>
					{/each}
				</div>
			{/if}

			<div class="actions">
				{#if accepted}
					<button class="btn btn-accepted" onclick={onskip}>Accepted</button>
				{:else}
					<button class="btn btn-accept" onclick={onaccept}>Accept</button>
					<button class="btn btn-skip" onclick={onskip}>Skip</button>
				{/if}
				{#if candidates.length > 1}
					<button class="btn btn-expand" onclick={() => expanded = !expanded}>
						{expanded ? '▲' : '▼'} {candidates.length}
					</button>
				{/if}
			</div>
		</div>

		{#if expanded}
			<div class="candidates-list">
				{#each candidates as candidate, i}
					<button
						class="alt-candidate"
						class:selected={i === selectedIndex}
						onclick={() => onselect(i)}
					>
						<TierBadge tier={candidate.tier} />
						<span class="alt-name">{candidate.candidate.displayName}</span>
						<span class="alt-score">{Math.round(candidate.score * 100)}%</span>
						{#if candidate.candidate.handle}
							<span class="alt-handle">@{candidate.candidate.handle}</span>
						{/if}
						{#each candidate.signals as signal}
							<span class="signal-pill small">{signalLabels[signal.type] ?? signal.type}</span>
						{/each}
					</button>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<style>
	.cell {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 12px;
		transition: border-color 0.15s;
	}

	.cell:hover {
		border-color: var(--accent);
	}

	.cell.accepted {
		border-color: var(--verified);
		background: color-mix(in srgb, var(--verified) 5%, var(--bg-card));
	}

	.cell.empty {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 80px;
		border-style: dashed;
	}

	.cell.empty:hover {
		border-color: var(--border);
	}

	.no-match {
		color: var(--text-muted);
		font-size: 0.85rem;
		font-style: italic;
	}

	.cell-header {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		margin-bottom: 8px;
	}

	.info {
		min-width: 0;
		flex: 1;
	}

	.name-row {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}

	.candidate-name {
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.handle {
		font-size: 0.75rem;
		color: var(--text-muted);
		display: block;
		margin-top: 2px;
	}

	.score-row {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 6px;
	}

	.score-bar {
		flex: 1;
		height: 4px;
		background: var(--bg-secondary);
		border-radius: 2px;
		overflow: hidden;
	}

	.score-fill {
		height: 100%;
		background: var(--accent);
		border-radius: 2px;
		transition: width 0.3s ease;
	}

	.score-label {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-secondary);
		white-space: nowrap;
	}

	.subs {
		font-size: 0.7rem;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.signals {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
		margin-bottom: 8px;
	}

	.avatar-signal {
		font-size: 0.65rem;
		font-weight: 600;
		color: var(--accent);
		white-space: nowrap;
	}

	.signal-pill {
		padding: 1px 6px;
		border-radius: 3px;
		font-size: 0.65rem;
		font-weight: 600;
		background: var(--bg-hover);
		color: var(--text-secondary);
		white-space: nowrap;
	}

	.signal-pill.avatar-signal-pill {
		background: color-mix(in srgb, var(--accent) 20%, var(--bg-hover));
		color: var(--accent);
	}

	.signal-pill.small {
		font-size: 0.6rem;
		padding: 0 4px;
	}

	.actions {
		display: flex;
		gap: 4px;
	}

	.btn {
		padding: 4px 10px;
		border: 1px solid var(--border);
		border-radius: 4px;
		font-size: 0.75rem;
		font-weight: 600;
		cursor: pointer;
		background: var(--bg-secondary);
		color: var(--text-secondary);
		transition: all 0.15s;
	}

	.btn:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.btn-accept {
		background: color-mix(in srgb, var(--verified) 15%, var(--bg-secondary));
		color: var(--verified);
		border-color: color-mix(in srgb, var(--verified) 30%, var(--border));
	}

	.btn-accept:hover {
		background: color-mix(in srgb, var(--verified) 25%, var(--bg-secondary));
	}

	.btn-accepted {
		background: var(--verified);
		color: #fff;
		border-color: var(--verified);
	}

	.btn-accepted:hover {
		background: color-mix(in srgb, var(--verified) 80%, #000);
	}

	.btn-skip {
		color: var(--text-muted);
	}

	.btn-expand {
		margin-left: auto;
		color: var(--text-muted);
		font-size: 0.7rem;
	}

	.candidates-list {
		margin-top: 8px;
		border-top: 1px solid var(--border);
		padding-top: 8px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.alt-candidate {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 8px;
		border-radius: 4px;
		border: 1px solid transparent;
		background: transparent;
		cursor: pointer;
		text-align: left;
		color: var(--text-secondary);
		font-size: 0.8rem;
		transition: all 0.1s;
		flex-wrap: wrap;
	}

	.alt-candidate:hover {
		background: var(--bg-hover);
	}

	.alt-candidate.selected {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 8%, transparent);
	}

	.alt-name {
		font-weight: 600;
		color: var(--text-primary);
	}

	.alt-score {
		font-size: 0.7rem;
		color: var(--text-muted);
	}

	.alt-handle {
		font-size: 0.7rem;
		color: var(--text-muted);
	}
</style>
