<script lang="ts">
	import type { ProgressEvent } from '$lib/types';

	let { events, error }: { events: ProgressEvent[]; error?: string } = $props();

	const phaseLabels: Record<string, string> = {
		ingest: 'Parsing CSV',
		enrich: 'Enriching channels',
		links: 'Extracting links',
		match: 'Matching platforms'
	};

	const phaseOrder = ['ingest', 'enrich', 'links', 'match'];

	let latestByPhase = $derived(() => {
		const map = new Map<string, ProgressEvent>();
		for (const e of events) {
			map.set(e.phase, e);
		}
		return map;
	});

	let currentPhase = $derived(events.length > 0 ? events[events.length - 1].phase : 'ingest');
	let latestMessage = $derived(events.length > 0 ? events[events.length - 1].message : 'Starting...');
</script>

<div class="progress-tracker">
	<div class="phases">
		{#each phaseOrder as phase, i}
			{@const evt = latestByPhase().get(phase)}
			{@const isComplete = evt != null && evt.current >= evt.total && evt.total > 0}
			{@const isActive = phase === currentPhase && !isComplete}
			<div class="phase" class:complete={isComplete} class:active={isActive}>
				<div class="phase-dot">
					{#if isComplete}
						<span class="check">&#x2713;</span>
					{:else if isActive}
						<span class="spinner"></span>
					{:else}
						<span class="num">{i + 1}</span>
					{/if}
				</div>
				<div class="phase-info">
					<span class="phase-label">{phaseLabels[phase]}</span>
					{#if evt}
						<span class="phase-progress">{evt.current}/{evt.total}</span>
					{/if}
				</div>
				{#if isActive && evt}
					<div class="progress-bar">
						<div class="progress-fill" style="width:{evt.total > 0 ? (evt.current / evt.total * 100) : 0}%"></div>
					</div>
				{/if}
			</div>
		{/each}
	</div>

	<div class="status-message">
		{#if error}
			<span class="error-msg">{error}</span>
		{:else}
			{latestMessage}
		{/if}
	</div>
</div>

<style>
	.progress-tracker {
		max-width: 480px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.phases {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.phase {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	.phase-dot {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--bg-secondary);
		border: 2px solid var(--border);
		flex-shrink: 0;
		font-size: 0.8rem;
		font-weight: 700;
		color: var(--text-muted);
	}

	.phase.complete .phase-dot {
		background: var(--verified);
		border-color: var(--verified);
		color: #fff;
	}

	.phase.active .phase-dot {
		border-color: var(--accent);
		color: var(--accent);
	}

	.check {
		font-size: 0.9rem;
	}

	.spinner {
		width: 14px;
		height: 14px;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.phase-info {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.phase-label {
		font-weight: 600;
		font-size: 0.9rem;
		color: var(--text-secondary);
	}

	.phase.complete .phase-label {
		color: var(--text-primary);
	}

	.phase.active .phase-label {
		color: var(--text-primary);
	}

	.phase-progress {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.progress-bar {
		width: 100%;
		height: 4px;
		background: var(--bg-secondary);
		border-radius: 2px;
		overflow: hidden;
		margin-left: 44px;
	}

	.progress-fill {
		height: 100%;
		background: var(--accent);
		border-radius: 2px;
		transition: width 0.3s ease;
	}

	.status-message {
		text-align: center;
		font-size: 0.85rem;
		color: var(--text-muted);
		min-height: 1.5em;
	}

	.error-msg {
		color: var(--danger);
		font-weight: 600;
	}
</style>
