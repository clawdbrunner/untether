<script lang="ts">
	import type { RunReport, PlatformSummary } from '$lib/jobs/run-report';

	let {
		report,
		onretry
	}: {
		report: RunReport;
		onretry?: () => void;
	} = $props();

	let hasRetryable = $derived(report.platforms.some(p => p.failedRetryable > 0));

	const platformLabels: Record<string, string> = {
		peertube: 'PeerTube',
		odysee: 'Odysee',
		dailymotion: 'Dailymotion',
		bitchute: 'BitChute',
		rumble: 'Rumble',
	};
</script>

<div class="run-summary">
	<h3 class="summary-title">Run Summary</h3>

	<div class="totals">
		<span class="total-stat ok">{report.totalSucceeded} succeeded</span>
		<span class="total-stat failed">{report.totalFailed} failed</span>
		{#if report.totalSkipped > 0}
			<span class="total-stat skipped">{report.totalSkipped} skipped</span>
		{/if}
	</div>

	<div class="platform-chips">
		{#each report.platforms as ps}
			<div class="platform-chip" class:has-errors={ps.failedRetryable + ps.failedPermanent + ps.skipped > 0}>
				<span class="chip-name">{platformLabels[ps.platform] ?? ps.platform}</span>
				<span class="chip-stat ok">{ps.succeeded}</span>
				{#if ps.matched > 0}
					<span class="chip-detail">({ps.matched} matched)</span>
				{/if}
				{#if ps.failedRetryable > 0}
					<span class="chip-stat warn">{ps.failedRetryable} retryable</span>
				{/if}
				{#if ps.failedPermanent > 0}
					<span class="chip-stat err">{ps.failedPermanent} permanent</span>
				{/if}
				{#if ps.skipped > 0}
					<span class="chip-stat skip">{ps.skipped} skipped</span>
				{/if}
				{#if ps.circuitBreakerTripped}
					<span class="chip-badge cb">CB tripped</span>
				{/if}
				{#if ps.userMessage}
					<span class="chip-message">{ps.userMessage}</span>
				{/if}
			</div>
		{/each}
	</div>

	{#if hasRetryable && onretry}
		<button class="retry-btn" onclick={onretry}>
			Retry failed tasks
		</button>
	{/if}
</div>

<style>
	.run-summary {
		padding: 16px;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 8px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.summary-title {
		font-size: 1rem;
		font-weight: 700;
		color: var(--text-primary);
		margin: 0;
	}

	.totals {
		display: flex;
		gap: 16px;
		flex-wrap: wrap;
	}

	.total-stat {
		font-size: 0.9rem;
		font-weight: 600;
	}

	.total-stat.ok { color: var(--verified, #38a169); }
	.total-stat.failed { color: var(--danger, #e53e3e); }
	.total-stat.skipped { color: var(--text-muted); }

	.platform-chips {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.platform-chip {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 6px;
		flex-wrap: wrap;
	}

	.platform-chip.has-errors {
		border-color: color-mix(in srgb, var(--possible, #e8a838) 40%, var(--border));
	}

	.chip-name {
		font-weight: 700;
		font-size: 0.85rem;
		color: var(--text-primary);
		min-width: 90px;
	}

	.chip-stat {
		font-size: 0.8rem;
		font-weight: 600;
	}

	.chip-stat.ok { color: var(--verified, #38a169); }
	.chip-stat.warn { color: var(--possible, #e8a838); }
	.chip-stat.err { color: var(--danger, #e53e3e); }
	.chip-stat.skip { color: var(--text-muted); }

	.chip-detail {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.chip-badge {
		font-size: 0.65rem;
		font-weight: 700;
		padding: 1px 6px;
		border-radius: 3px;
		text-transform: uppercase;
	}

	.chip-badge.cb {
		background: color-mix(in srgb, var(--danger, #e53e3e) 15%, var(--bg-hover));
		color: var(--danger, #e53e3e);
	}

	.chip-message {
		font-size: 0.75rem;
		color: var(--text-muted);
		font-style: italic;
	}

	.retry-btn {
		align-self: flex-start;
		padding: 8px 16px;
		background: color-mix(in srgb, var(--possible, #e8a838) 15%, var(--bg-card));
		border: 1px solid color-mix(in srgb, var(--possible, #e8a838) 30%, var(--border));
		border-radius: 6px;
		color: var(--possible, #e8a838);
		font-weight: 700;
		font-size: 0.85rem;
		cursor: pointer;
		transition: all 0.15s;
	}

	.retry-btn:hover {
		background: color-mix(in srgb, var(--possible, #e8a838) 25%, var(--bg-card));
	}
</style>
