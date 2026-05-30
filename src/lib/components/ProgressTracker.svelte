<script lang="ts">
	import type { ProgressEvent } from '$lib/types';

	let { events, error, platformProgress }: {
		events: ProgressEvent[];
		error?: string;
		platformProgress?: Record<string, { total: number; completed: number; failed: number; status: string }>;
	} = $props();

	const platformLabels: Record<string, string> = {
		peertube: 'PeerTube',
		odysee: 'Odysee',
		dailymotion: 'Dailymotion',
		bitchute: 'BitChute',
		rumble: 'Rumble',
	};

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

	{#if currentPhase === 'match' && platformProgress && Object.keys(platformProgress).length > 0}
		<div class="platform-bars">
			{#each Object.entries(platformProgress) as [platform, pp]}
				<div class="platform-row" class:complete={pp.status === 'complete'} class:failed={pp.status === 'failed'}>
					<span class="platform-name">{platformLabels[platform] ?? platform}</span>
					<div class="platform-bar">
						<div class="platform-fill" style="width:{pp.total > 0 ? (pp.completed / pp.total * 100) : 0}%"></div>
						{#if pp.failed > 0}
							<div class="platform-failed" style="width:{pp.total > 0 ? (pp.failed / pp.total * 100) : 0}%"></div>
						{/if}
					</div>
					<span class="platform-count">{pp.completed}/{pp.total}{#if pp.failed > 0} ({pp.failed} failed){/if}</span>
				</div>
			{/each}
		</div>
	{/if}

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

	.platform-bars {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.platform-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.platform-name {
		width: 80px;
		font-weight: 600;
		font-size: 0.85rem;
		color: var(--text-secondary);
		flex-shrink: 0;
	}

	.platform-bar {
		flex: 1;
		height: 6px;
		background: var(--bg-secondary);
		border-radius: 3px;
		overflow: hidden;
		display: flex;
	}

	.platform-fill {
		height: 100%;
		background: var(--accent);
		transition: width 0.3s ease;
	}

	.platform-failed {
		height: 100%;
		background: var(--warning);
		transition: width 0.3s ease;
	}

	.platform-count {
		font-size: 0.75rem;
		color: var(--text-muted);
		min-width: 60px;
		text-align: right;
		flex-shrink: 0;
	}

	.platform-row.complete .platform-fill {
		background: var(--verified);
	}

	.platform-row.failed .platform-name {
		color: var(--danger);
	}
</style>
