<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}

<style>
	:global(:root) {
		--bg-primary: #0f1117;
		--bg-secondary: #1a1d27;
		--bg-card: #232734;
		--bg-hover: #2a2f3f;
		--text-primary: #e4e4e7;
		--text-secondary: #9ca3af;
		--text-muted: #6b7280;
		--border: #2d3348;
		--accent: #6366f1;
		--verified: #22c55e;
		--likely: #3b82f6;
		--possible: #eab308;
		--weak: #6b7280;
		--danger: #ef4444;
	}

	:global(*) {
		margin: 0;
		padding: 0;
		box-sizing: border-box;
	}

	:global(html) {
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen,
			Ubuntu, Cantarell, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
		-webkit-font-smoothing: antialiased;
		-moz-osx-font-smoothing: grayscale;
	}

	:global(body) {
		background: var(--bg-primary);
		color: var(--text-primary);
		line-height: 1.5;
	}

	:global(code) {
		font-family: 'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono', monospace;
	}

	:global(a) {
		color: var(--accent);
		text-decoration: none;
	}

	:global(a:hover) {
		text-decoration: underline;
	}

	:global(::selection) {
		background: color-mix(in srgb, var(--accent) 40%, transparent);
	}

	:global(::-webkit-scrollbar) {
		width: 8px;
		height: 8px;
	}

	:global(::-webkit-scrollbar-track) {
		background: var(--bg-primary);
	}

	:global(::-webkit-scrollbar-thumb) {
		background: var(--border);
		border-radius: 4px;
	}

	:global(::-webkit-scrollbar-thumb:hover) {
		background: var(--text-muted);
	}
</style>
