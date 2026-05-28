<script lang="ts">
	import type { PipelineResult, ConfidenceTier, ScoredCandidate } from '$lib/types';

	let {
		result,
		selections,
		selectedIndices
	}: {
		result: PipelineResult;
		selections: Map<string, Map<string, string>>;
		selectedIndices: Map<string, Map<string, number>>;
	} = $props();

	let format = $state<'txt' | 'newpipe' | 'csv'>('txt');
	let exportMode = $state<'accepted' | 'likely+'>('accepted');
	let showPreview = $state(false);

	interface ExportEntry {
		channelTitle: string;
		platform: string;
		url: string;
		tier: ConfidenceTier;
		score: number;
	}

	function getEntries(): ExportEntry[] {
		const entries: ExportEntry[] = [];

		if (exportMode === 'accepted') {
			for (const [channelId, platformMap] of selections) {
				const channel = result.channels.find((c) => c.id === channelId);
				if (!channel) continue;
				for (const [platform, url] of platformMap) {
					const match = result.matches.find(
						(m) => m.youtubeChannel.id === channelId && m.platform === platform
					);
					const idx = selectedIndices.get(channelId)?.get(platform) ?? 0;
					const candidate = match?.candidates[idx];
					entries.push({
						channelTitle: channel.title,
						platform,
						url,
						tier: candidate?.tier ?? 'weak',
						score: candidate?.score ?? 0
					});
				}
			}
		} else {
			// Export all >= likely
			for (const match of result.matches) {
				const idx = selectedIndices.get(match.youtubeChannel.id)?.get(match.platform) ?? 0;
				const candidate = match.candidates[idx] ?? match.candidates[0];
				if (!candidate) continue;
				if (candidate.tier === 'verified' || candidate.tier === 'likely') {
					entries.push({
						channelTitle: match.youtubeChannel.title,
						platform: match.platform,
						url: candidate.candidate.url,
						tier: candidate.tier,
						score: candidate.score
					});
				}
			}
		}

		return entries;
	}

	function generateTxt(entries: ExportEntry[]): string {
		const date = new Date().toISOString().split('T')[0];
		const lines: string[] = [`# Untether Export — generated ${date}`];
		const byPlatform = new Map<string, ExportEntry[]>();

		for (const e of entries) {
			if (!byPlatform.has(e.platform)) byPlatform.set(e.platform, []);
			byPlatform.get(e.platform)!.push(e);
		}

		for (const [platform, platformEntries] of byPlatform) {
			const label = platform === 'peertube' ? 'PeerTube' : 'Odysee';
			lines.push(`# ${label} (${platformEntries.length} channels)`);
			for (const e of platformEntries) {
				lines.push(e.url);
			}
		}

		return lines.join('\n') + '\n';
	}

	function generateNewpipe(entries: ExportEntry[]): string {
		const ptEntries = entries.filter((e) => e.platform === 'peertube');
		const subscriptions = ptEntries.map((e) => ({
			service_id: 4,
			url: e.url,
			name: e.channelTitle
		}));
		return JSON.stringify({ app_version: '0.27.0', app_version_int: 998, subscriptions }, null, 2);
	}

	function generateCsv(entries: ExportEntry[]): string {
		const header = 'channel,platform,url,tier,score';
		const rows = entries.map(
			(e) => `"${e.channelTitle.replace(/"/g, '""')}",${e.platform},${e.url},${e.tier},${Math.round(e.score * 100)}`
		);
		return [header, ...rows].join('\n') + '\n';
	}

	let exportEntries = $derived(getEntries());

	let previewText = $derived(() => {
		const entries = getEntries();
		if (format === 'txt') return generateTxt(entries);
		if (format === 'newpipe') return generateNewpipe(entries);
		return generateCsv(entries);
	});

	let platformCounts = $derived(() => {
		const counts = new Map<string, number>();
		for (const e of getEntries()) {
			counts.set(e.platform, (counts.get(e.platform) ?? 0) + 1);
		}
		return counts;
	});

	function download() {
		const entries = getEntries();
		let content: string;
		let filename: string;
		let mime: string;

		if (format === 'txt') {
			content = generateTxt(entries);
			filename = 'untether-export.txt';
			mime = 'text/plain';
		} else if (format === 'newpipe') {
			content = generateNewpipe(entries);
			filename = 'untether-newpipe.json';
			mime = 'application/json';
		} else {
			content = generateCsv(entries);
			filename = 'untether-export.csv';
			mime = 'text/csv';
		}

		const blob = new Blob([content], { type: mime });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
	}
</script>

<div class="export-panel">
	<h2>Export</h2>

	<div class="export-options">
		<div class="option-group">
			<span class="option-label">What to export</span>
			<div class="radio-group">
				<label class="radio-label">
					<input type="radio" value="accepted" bind:group={exportMode} />
					Export all accepted ({exportEntries.length} channels)
				</label>
				<label class="radio-label">
					<input type="radio" value="likely+" bind:group={exportMode} />
					Export all &ge; Likely
				</label>
			</div>
		</div>

		<div class="option-group">
			<span class="option-label">Format</span>
			<div class="format-cards">
				<button
					class="format-card"
					class:selected={format === 'txt'}
					onclick={() => format = 'txt'}
				>
					<span class="format-name">URL List (.txt)</span>
					<span class="format-desc">Grayjay, MeTube, yt-dlp</span>
				</button>
				<button
					class="format-card"
					class:selected={format === 'newpipe'}
					onclick={() => format = 'newpipe'}
				>
					<span class="format-name">NewPipe (.json)</span>
					<span class="format-desc">PeerTube only</span>
				</button>
				<button
					class="format-card"
					class:selected={format === 'csv'}
					onclick={() => format = 'csv'}
				>
					<span class="format-name">CSV (.csv)</span>
					<span class="format-desc">Spreadsheet analysis</span>
				</button>
			</div>
		</div>

		<div class="platform-counts">
			{#each [...platformCounts()] as [platform, count]}
				<span class="count-badge">
					{platform === 'peertube' ? 'PeerTube' : 'Odysee'}: {count}
				</span>
			{/each}
		</div>
	</div>

	<div class="preview-section">
		<button class="preview-toggle" onclick={() => showPreview = !showPreview}>
			{showPreview ? 'Hide' : 'Show'} preview
		</button>
		{#if showPreview}
			<pre class="preview-content">{previewText()}</pre>
		{/if}
	</div>

	<button class="download-btn" onclick={download} disabled={exportEntries.length === 0}>
		Download {format === 'txt' ? '.txt' : format === 'newpipe' ? '.json' : '.csv'}
		({exportEntries.length} channels)
	</button>
</div>

<style>
	.export-panel {
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	h2 {
		margin: 0;
		font-size: 1.2rem;
		color: var(--text-primary);
	}

	.export-options {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.option-group {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.option-label {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.radio-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.radio-label {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.9rem;
		color: var(--text-primary);
		cursor: pointer;
	}

	.radio-label input[type="radio"] {
		accent-color: var(--accent);
	}

	.format-cards {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 8px;
	}

	.format-card {
		padding: 12px;
		background: var(--bg-card);
		border: 2px solid var(--border);
		border-radius: 8px;
		cursor: pointer;
		text-align: left;
		display: flex;
		flex-direction: column;
		gap: 2px;
		transition: all 0.15s;
		color: var(--text-primary);
	}

	.format-card:hover {
		border-color: var(--accent);
	}

	.format-card.selected {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 8%, var(--bg-card));
	}

	.format-name {
		font-weight: 700;
		font-size: 0.85rem;
	}

	.format-desc {
		font-size: 0.7rem;
		color: var(--text-muted);
	}

	.platform-counts {
		display: flex;
		gap: 8px;
	}

	.count-badge {
		padding: 4px 10px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 4px;
		font-size: 0.8rem;
		color: var(--text-secondary);
		font-weight: 600;
	}

	.preview-section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.preview-toggle {
		align-self: flex-start;
		background: none;
		border: none;
		color: var(--accent);
		font-size: 0.8rem;
		cursor: pointer;
		text-decoration: underline;
		padding: 0;
	}

	.preview-content {
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 16px;
		font-size: 0.75rem;
		color: var(--text-secondary);
		overflow-x: auto;
		max-height: 300px;
		overflow-y: auto;
		margin: 0;
		white-space: pre-wrap;
		word-break: break-all;
	}

	.download-btn {
		padding: 14px 24px;
		background: var(--accent);
		color: #fff;
		border: none;
		border-radius: 8px;
		font-size: 1rem;
		font-weight: 700;
		cursor: pointer;
		transition: all 0.15s;
	}

	.download-btn:hover:not(:disabled) {
		filter: brightness(1.15);
	}

	.download-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	@media (max-width: 768px) {
		.format-cards {
			grid-template-columns: 1fr;
		}
	}
</style>
