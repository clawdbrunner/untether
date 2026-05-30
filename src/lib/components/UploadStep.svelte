<script lang="ts">
	let {
		onstart
	}: {
		onstart: (csv: string, platforms: ('peertube' | 'odysee' | 'dailymotion' | 'bitchute' | 'rumble')[], apiKey?: string) => void;
	} = $props();

	let csvText = $state('');
	let fileName = $state('');
	let peertube = $state(true);
	let odysee = $state(true);
	let dailymotion = $state(true);
	let bitchute = $state(true);
	let rumble = $state(true);
	let apiKey = $state('');
	let showApiHelp = $state(false);
	let dragOver = $state(false);

	let canStart = $derived(csvText.length > 0 && (peertube || odysee || dailymotion || bitchute || rumble));

	function handleFile(file: File) {
		if (!file.name.endsWith('.csv')) return;
		fileName = file.name;
		const reader = new FileReader();
		reader.onload = () => {
			csvText = reader.result as string;
		};
		reader.readAsText(file);
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		const file = e.dataTransfer?.files[0];
		if (file) handleFile(file);
	}

	function onDragOver(e: DragEvent) {
		e.preventDefault();
		dragOver = true;
	}

	function onDragLeave() {
		dragOver = false;
	}

	function onFileInput(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (file) handleFile(file);
	}

	function submit() {
		if (!canStart) return;
		const platforms: ('peertube' | 'odysee' | 'dailymotion' | 'bitchute' | 'rumble')[] = [];
		if (peertube) platforms.push('peertube');
		if (odysee) platforms.push('odysee');
		if (dailymotion) platforms.push('dailymotion');
		if (bitchute) platforms.push('bitchute');
		if (rumble) platforms.push('rumble');
		onstart(csvText, platforms, apiKey || undefined);
	}
</script>

<div class="upload-step">
	<div class="header">
		<h1>Untether</h1>
		<p class="subtitle">Find your YouTube creators on alternative platforms</p>
	</div>

	<div
		class="drop-zone"
		class:drag-over={dragOver}
		class:has-file={csvText.length > 0}
		ondrop={onDrop}
		ondragover={onDragOver}
		ondragleave={onDragLeave}
		role="button"
		tabindex="0"
	>
		{#if csvText}
			<div class="file-loaded">
				<span class="file-icon">&#x2705;</span>
				<span class="file-name">{fileName}</span>
				<button class="clear-btn" onclick={() => { csvText = ''; fileName = ''; }}>Clear</button>
			</div>
		{:else}
			<div class="drop-prompt">
				<span class="drop-icon">&#x1F4C1;</span>
				<p>Drop your <code>subscriptions.csv</code> here</p>
				<p class="or">or</p>
				<label class="browse-btn">
					Browse files
					<input type="file" accept=".csv" onchange={onFileInput} hidden />
				</label>
			</div>
		{/if}
	</div>

	<div class="hint">
		<span class="hint-label">Expected format:</span>
		<code>Channel Id,Channel Url,Channel Title</code>
		<span class="hint-detail">Export from Google Takeout &rarr; YouTube &rarr; subscriptions.csv</span>
	</div>

	<div class="options">
		<fieldset class="platforms">
			<legend>Target platforms</legend>
			<label class="checkbox-label">
				<input type="checkbox" bind:checked={peertube} />
				PeerTube
			</label>
			<label class="checkbox-label">
				<input type="checkbox" bind:checked={odysee} />
				Odysee
			</label>
			<label class="checkbox-label">
				<input type="checkbox" bind:checked={dailymotion} />
				Dailymotion
			</label>
			<label class="checkbox-label">
				<input type="checkbox" bind:checked={bitchute} />
				BitChute
			</label>
			<label class="checkbox-label">
				<input type="checkbox" bind:checked={rumble} />
				Rumble
				<span class="badge-warning" title="Rumble is Cloudflare-protected. Works best on self-hosted instances with residential IP.">self-host recommended</span>
			</label>
		</fieldset>

		<div class="api-key-group">
			<label class="api-key-label">
				YouTube API Key <span class="optional">(optional)</span>
				<button class="help-btn" onclick={() => showApiHelp = !showApiHelp}>
					What's this?
				</button>
			</label>
			<input
				type="password"
				class="api-key-input"
				placeholder="AIza..."
				bind:value={apiKey}
			/>
			{#if showApiHelp}
				<p class="api-help">
					A YouTube Data API key speeds up enrichment and avoids rate limits.
					Without one, the tool falls back to yt-dlp (slower but works).
					Get a free key from the Google Cloud Console.
				</p>
			{/if}
		</div>
	</div>

	<button class="start-btn" disabled={!canStart} onclick={submit}>
		Start matching
	</button>
</div>

<style>
	.upload-step {
		max-width: 560px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 24px;
	}

	.header {
		text-align: center;
	}

	h1 {
		font-size: 2rem;
		font-weight: 800;
		color: var(--text-primary);
		margin: 0;
	}

	.subtitle {
		color: var(--text-secondary);
		margin: 4px 0 0;
		font-size: 0.95rem;
	}

	.drop-zone {
		border: 2px dashed var(--border);
		border-radius: 12px;
		padding: 40px 24px;
		text-align: center;
		cursor: pointer;
		transition: all 0.2s;
		background: var(--bg-secondary);
	}

	.drop-zone:hover,
	.drop-zone.drag-over {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 5%, var(--bg-secondary));
	}

	.drop-zone.has-file {
		border-style: solid;
		border-color: var(--verified);
		background: color-mix(in srgb, var(--verified) 5%, var(--bg-secondary));
	}

	.drop-prompt p {
		margin: 4px 0;
		color: var(--text-secondary);
	}

	.drop-icon {
		font-size: 2rem;
		display: block;
		margin-bottom: 8px;
	}

	.or {
		font-size: 0.8rem;
		color: var(--text-muted);
	}

	.browse-btn {
		display: inline-block;
		padding: 8px 20px;
		background: var(--accent);
		color: #fff;
		border-radius: 6px;
		font-weight: 600;
		font-size: 0.85rem;
		cursor: pointer;
		margin-top: 4px;
	}

	.browse-btn:hover {
		filter: brightness(1.1);
	}

	.file-loaded {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
	}

	.file-icon {
		font-size: 1.4rem;
	}

	.file-name {
		font-weight: 600;
		color: var(--text-primary);
	}

	.clear-btn {
		padding: 4px 10px;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--bg-card);
		color: var(--text-muted);
		font-size: 0.75rem;
		cursor: pointer;
	}

	.clear-btn:hover {
		color: var(--danger);
		border-color: var(--danger);
	}

	.hint {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 10px 14px;
		background: var(--bg-card);
		border-radius: 6px;
		border: 1px solid var(--border);
	}

	.hint-label {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.hint code {
		font-size: 0.85rem;
		color: var(--accent);
	}

	.hint-detail {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.options {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	fieldset {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 12px 16px;
		margin: 0;
	}

	legend {
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-secondary);
		padding: 0 6px;
	}

	.platforms {
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
	}

	.checkbox-label {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.9rem;
		color: var(--text-primary);
		cursor: pointer;
	}

	.checkbox-label input[type="checkbox"] {
		accent-color: var(--accent);
		width: 16px;
		height: 16px;
	}

	.api-key-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.api-key-label {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-secondary);
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.optional {
		font-weight: 400;
		color: var(--text-muted);
		font-size: 0.8rem;
	}

	.help-btn {
		background: none;
		border: none;
		color: var(--accent);
		font-size: 0.75rem;
		cursor: pointer;
		text-decoration: underline;
		padding: 0;
	}

	.api-key-input {
		padding: 8px 12px;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--text-primary);
		font-size: 0.9rem;
		font-family: monospace;
	}

	.api-key-input:focus {
		outline: none;
		border-color: var(--accent);
	}

	.api-help {
		font-size: 0.8rem;
		color: var(--text-muted);
		line-height: 1.5;
		padding: 8px 12px;
		background: var(--bg-secondary);
		border-radius: 6px;
		margin: 0;
	}

	.start-btn {
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

	.start-btn:hover:not(:disabled) {
		filter: brightness(1.15);
		transform: translateY(-1px);
	}

	.start-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.badge-warning {
		font-size: 0.6rem;
		font-weight: 600;
		padding: 1px 5px;
		border: 1px solid color-mix(in srgb, var(--text-muted) 40%, transparent);
		border-radius: 3px;
		color: var(--text-muted);
		white-space: nowrap;
		cursor: help;
	}
</style>
