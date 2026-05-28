<script lang="ts">
	let { youtubeUrl, candidateUrl, channelName = 'Channel' }: {
		youtubeUrl?: string;
		candidateUrl?: string;
		channelName?: string;
	} = $props();
</script>

<div class="avatar-compare">
	{#if youtubeUrl}
		<img src={youtubeUrl} alt="{channelName} (YouTube)" class="avatar yt" />
	{:else}
		<div class="avatar placeholder">YT</div>
	{/if}
	{#if candidateUrl}
		<img src={candidateUrl} alt="{channelName} (candidate)" class="avatar candidate" />
	{:else}
		<div class="avatar placeholder">?</div>
	{/if}
</div>

<style>
	.avatar-compare {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.avatar {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		object-fit: cover;
		border: 2px solid var(--border);
	}

	.avatar.yt {
		border-color: var(--text-muted);
	}

	.avatar.candidate {
		border-color: var(--accent);
		margin-left: -8px;
	}

	.placeholder {
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--bg-secondary);
		color: var(--text-muted);
		font-size: 0.6rem;
		font-weight: 600;
	}
</style>
