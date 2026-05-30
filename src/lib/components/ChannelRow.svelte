<script lang="ts">
	import type { YouTubeChannel, MatchResult, TaskStatus, ErrorClass } from '$lib/types';
	import CandidateCell from './CandidateCell.svelte';

	let {
		channel,
		platforms,
		matchesByPlatform,
		selections,
		selectedIndices,
		taskStatuses,
		onaccept,
		onskip,
		onselectcandidate
	}: {
		channel: YouTubeChannel;
		platforms: string[];
		matchesByPlatform: Map<string, MatchResult>;
		selections: Map<string, string>;
		selectedIndices: Map<string, number>;
		taskStatuses?: Map<string, { status: TaskStatus; errorClass?: ErrorClass }>;
		onaccept: (platform: string) => void;
		onskip: (platform: string) => void;
		onselectcandidate: (platform: string, index: number) => void;
	} = $props();

	function formatSubs(n?: number): string {
		if (n == null) return '';
		if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M subs';
		if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K subs';
		return n + ' subs';
	}
</script>

<div class="channel-row">
	<div class="yt-channel">
		{#if channel.avatarUrl}
			<img src={channel.avatarUrl} alt="" class="yt-avatar" />
		{:else}
			<div class="yt-avatar placeholder" title="No avatar">
				{channel.title.charAt(0).toUpperCase()}
			</div>
		{/if}
		<div class="yt-info">
			<span class="yt-name">{channel.title}</span>
			{#if channel.handle}
				<span class="yt-handle">@{channel.handle?.replace(/^@/, '')}</span>
			{/if}
			{#if channel.subscriberCount}
				<span class="yt-subs">{formatSubs(channel.subscriberCount)}</span>
			{/if}
		</div>
	</div>

	{#each platforms as platform}
		{@const match = matchesByPlatform.get(platform)}
		{@const ts = taskStatuses?.get(platform)}
		<div class="platform-cell">
			<CandidateCell
				candidates={match?.candidates ?? []}
				youtubeAvatarUrl={channel.avatarUrl}
				channelName={channel.title}
				accepted={selections.has(platform)}
				selectedIndex={selectedIndices.get(platform) ?? 0}
				taskStatus={ts?.status}
				taskErrorClass={ts?.errorClass}
				onaccept={() => onaccept(platform)}
				onskip={() => onskip(platform)}
				onselect={(i) => onselectcandidate(platform, i)}
			/>
		</div>
	{/each}
</div>

<style>
	.channel-row {
		display: grid;
		grid-template-columns: 240px repeat(var(--platform-count, 2), 1fr);
		gap: 12px;
		padding: 12px 0;
		border-bottom: 1px solid var(--border);
		align-items: start;
	}

	.yt-channel {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		padding-right: 8px;
	}

	.yt-avatar {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		object-fit: cover;
		flex-shrink: 0;
		border: 2px solid var(--border);
	}

	.placeholder {
		background: var(--bg-secondary);
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-muted);
		font-size: 1rem;
		font-weight: 700;
	}

	.yt-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.yt-name {
		font-weight: 600;
		font-size: 0.9rem;
		color: var(--text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.yt-handle {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.yt-subs {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	@media (max-width: 768px) {
		.channel-row {
			grid-template-columns: 1fr;
			gap: 8px;
		}

		.yt-channel {
			padding-bottom: 8px;
			border-bottom: 1px solid var(--border);
		}
	}
</style>
