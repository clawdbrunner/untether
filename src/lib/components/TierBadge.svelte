<script lang="ts">
	import type { ConfidenceTier } from '$lib/types';

	let { tier }: { tier: ConfidenceTier } = $props();

	const colors: Record<ConfidenceTier, { bg: string; text: string; label: string }> = {
		verified: { bg: '#166534', text: '#bbf7d0', label: 'VERIFIED' },
		likely: { bg: '#1e40af', text: '#bfdbfe', label: 'LIKELY' },
		possible: { bg: '#854d0e', text: '#fef08a', label: 'POSSIBLE' },
		weak: { bg: '#525252', text: '#d4d4d4', label: 'WEAK' }
	};
</script>

<span class="tier-badge" style="background:{colors[tier].bg};color:{colors[tier].text}">
	{colors[tier].label}
</span>

<style>
	.tier-badge {
		display: inline-block;
		padding: 2px 8px;
		border-radius: 4px;
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.05em;
		line-height: 1.4;
		white-space: nowrap;
	}
</style>
