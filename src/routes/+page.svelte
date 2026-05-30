<script lang="ts">
	import type { PipelineResult, ProgressEvent, ConfidenceTier, Job, JobStatus } from '$lib/types';
	import UploadStep from '$lib/components/UploadStep.svelte';
	import ProgressTracker from '$lib/components/ProgressTracker.svelte';
	import ResultsGrid from '$lib/components/ResultsGrid.svelte';
	import ExportPanel from '$lib/components/ExportPanel.svelte';

	type AppStep = 'upload' | 'running' | 'results';

	let step = $state<AppStep>('upload');
	let pipelineResult = $state<PipelineResult | null>(null);
	let progressEvents = $state<ProgressEvent[]>([]);
	let pipelineError = $state<string | undefined>();
	let currentJobId = $state<string | undefined>();
	let jobStatus = $state<JobStatus | undefined>();

	// channelId → platform → url
	let selections = $state(new Map<string, Map<string, string>>());
	// channelId → platform → candidate index
	let selectedIndices = $state(new Map<string, Map<string, number>>());

	const tierRank: Record<ConfidenceTier, number> = {
		verified: 4,
		likely: 3,
		possible: 2,
		weak: 1
	};

	let pollInterval: ReturnType<typeof setInterval> | undefined;

	async function handleStart(csv: string, platforms: ('peertube' | 'odysee' | 'dailymotion' | 'bitchute' | 'rumble')[], apiKey?: string) {
		step = 'running';
		progressEvents = [];
		pipelineError = undefined;
		selections = new Map();
		selectedIndices = new Map();

		try {
			// Create job via API
			const res = await fetch('/api/jobs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ csv, platforms, apiKey })
			});

			const data = await res.json();
			if (!res.ok) {
				pipelineError = data.error || 'Failed to create job';
				return;
			}

			currentJobId = data.jobId;
			jobStatus = 'running';

			progressEvents.push({
				phase: 'ingest',
				current: 0,
				total: 0,
				message: 'Job created, processing...'
			});

			// Poll for job status
			pollInterval = setInterval(pollJobStatus, 2000);
		} catch (err) {
			pipelineError = err instanceof Error ? err.message : 'Network error';
		}
	}

	async function pollJobStatus() {
		if (!currentJobId) return;

		try {
			const res = await fetch(`/api/jobs/${currentJobId}`);
			const data = await res.json();

			if (!res.ok) {
				clearInterval(pollInterval);
				pollInterval = undefined;
				pipelineError = data.error || 'Job failed';
				return;
			}

			const job: Job = data.job;
			jobStatus = job.status;

			// Update progress
			progressEvents = [{
				phase: 'match',
				current: job.progress.completed,
				total: job.progress.total,
				message: `Processing: ${job.progress.completed}/${job.progress.total} tasks complete`
			}];

			if (job.status === 'completed') {
				clearInterval(pollInterval);
				pollInterval = undefined;
				await loadResults();
			} else if (job.status === 'failed') {
				clearInterval(pollInterval);
				pollInterval = undefined;
				pipelineError = 'Job failed';
			} else if (job.status === 'paused') {
				clearInterval(pollInterval);
				pollInterval = undefined;
				pipelineError = 'Job paused';
			}
		} catch {
			// Network error — keep polling
		}
	}

	async function loadResults() {
		if (!currentJobId) return;

		const res = await fetch(`/api/jobs/${currentJobId}/results`);
		const data = await res.json();

		if (res.ok) {
			pipelineResult = data.result;
			step = 'results';

			// Auto-accept verified matches
			if (pipelineResult) {
				for (const match of pipelineResult.matches) {
					const top = match.candidates[0];
					if (top && top.tier === 'verified') {
						acceptMatch(match.youtubeChannel.id, match.platform);
					}
				}
			}
		} else {
			pipelineError = data.error || 'Failed to load results';
		}
	}

	async function handlePause() {
		if (!currentJobId) return;
		await fetch(`/api/jobs/${currentJobId}/pause`, { method: 'POST' });
		jobStatus = 'paused';
	}

	async function handleResume() {
		if (!currentJobId) return;
		await fetch(`/api/jobs/${currentJobId}/resume`, { method: 'POST' });
		jobStatus = 'running';
		pollInterval = setInterval(pollJobStatus, 2000);
	}

	function acceptMatch(channelId: string, platform: string) {
		if (!pipelineResult) return;
		const match = pipelineResult.matches.find(
			(m) => m.youtubeChannel.id === channelId && m.platform === platform
		);
		if (!match) return;

		const idx = selectedIndices.get(channelId)?.get(platform) ?? 0;
		const candidate = match.candidates[idx] ?? match.candidates[0];
		if (!candidate) return;

		const channelMap = selections.get(channelId) ?? new Map();
		channelMap.set(platform, candidate.candidate.url);
		selections.set(channelId, channelMap);
		selections = new Map(selections);

		// Persist to server
		if (currentJobId) {
			fetch(`/api/jobs/${currentJobId}/selections`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					channelId, platform,
					url: candidate.candidate.url,
					tier: candidate.tier,
				}),
			});
		}
	}

	function skipMatch(channelId: string, platform: string) {
		const channelMap = selections.get(channelId);
		if (channelMap) {
			channelMap.delete(platform);
			if (channelMap.size === 0) selections.delete(channelId);
			selections = new Map(selections);
		}
	}

	function selectCandidate(channelId: string, platform: string, index: number) {
		const channelMap = selectedIndices.get(channelId) ?? new Map();
		channelMap.set(platform, index);
		selectedIndices.set(channelId, channelMap);
		selectedIndices = new Map(selectedIndices);

		if (selections.get(channelId)?.has(platform)) {
			acceptMatch(channelId, platform);
		}
	}

	function handleBulkAction(action: string) {
		if (!pipelineResult) return;

		if (action === 'clear') {
			selections = new Map();
			if (currentJobId) {
				fetch(`/api/jobs/${currentJobId}/selections`, { method: 'DELETE' });
			}
			return;
		}

		const minTier = action === 'accept-verified' ? 4 : 3;

		for (const match of pipelineResult.matches) {
			const idx = selectedIndices.get(match.youtubeChannel.id)?.get(match.platform) ?? 0;
			const candidate = match.candidates[idx] ?? match.candidates[0];
			if (!candidate) continue;
			if (tierRank[candidate.tier] >= minTier) {
				acceptMatch(match.youtubeChannel.id, match.platform);
			}
		}
	}

	function resetToUpload() {
		if (pollInterval) {
			clearInterval(pollInterval);
			pollInterval = undefined;
		}
		step = 'upload';
		pipelineResult = null;
		progressEvents = [];
		pipelineError = undefined;
		currentJobId = undefined;
		jobStatus = undefined;
		selections = new Map();
		selectedIndices = new Map();
	}
</script>

<svelte:head>
	<title>Untether — Find your creators elsewhere</title>
</svelte:head>

<div class="app">
	{#if step === 'upload'}
		<div class="step-container upload-container">
			<UploadStep onstart={handleStart} />
		</div>
	{:else if step === 'running'}
		<div class="step-container progress-container">
			<h1 class="running-title">Finding your creators...</h1>
			<ProgressTracker events={progressEvents} error={pipelineError} />
			<div class="running-controls">
				{#if jobStatus === 'running'}
					<button class="pause-btn" onclick={handlePause}>⏸ Pause</button>
				{:else if jobStatus === 'paused'}
					<button class="resume-btn" onclick={handleResume}>▶ Resume</button>
				{/if}
				{#if pipelineError}
					<button class="retry-btn" onclick={resetToUpload}>Try again</button>
				{/if}
			</div>
		</div>
	{:else if step === 'results' && pipelineResult}
		<div class="results-container">
			<div class="results-header">
				<button class="back-btn" onclick={resetToUpload}>&larr; New search</button>
				<h1 class="results-title">Untether</h1>
			</div>

			<ResultsGrid
				result={pipelineResult}
				{selections}
				{selectedIndices}
				onaccept={acceptMatch}
				onskip={skipMatch}
				onselectcandidate={selectCandidate}
				onbulkaction={handleBulkAction}
			/>

			<ExportPanel
				result={pipelineResult}
				{selections}
				{selectedIndices}
			/>
		</div>
	{/if}
</div>

<style>
	.app {
		min-height: 100vh;
		padding: 24px;
	}

	.step-container {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: 80vh;
	}

	.upload-container {
		padding-top: 60px;
	}

	.progress-container {
		gap: 24px;
		text-align: center;
	}

	.running-title {
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--text-primary);
		margin: 0;
	}

	.running-controls {
		display: flex;
		gap: 12px;
		justify-content: center;
	}

	.pause-btn, .resume-btn, .retry-btn {
		padding: 10px 24px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--text-primary);
		font-size: 0.9rem;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.15s;
	}

	.pause-btn:hover, .resume-btn:hover, .retry-btn:hover {
		background: var(--bg-hover);
	}

	.results-container {
		max-width: 1200px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 24px;
	}

	.results-header {
		display: flex;
		align-items: center;
		gap: 16px;
	}

	.back-btn {
		padding: 6px 12px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--text-secondary);
		font-size: 0.85rem;
		cursor: pointer;
		transition: all 0.15s;
	}

	.back-btn:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.results-title {
		font-size: 1.3rem;
		font-weight: 800;
		color: var(--text-primary);
		margin: 0;
	}
</style>
