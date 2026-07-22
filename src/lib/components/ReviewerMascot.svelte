<script lang="ts">
	/**
	 * Line-icon mascots for reviewer agents, drawn in the same lucide stroke
	 * style as the dock cat (24px viewBox, round caps, currentColor). Keyed
	 * by the reviewer's `icon` field; unknown ids fall back to the owl.
	 */
	interface Props {
		icon: string;
		size?: number;
		strokeWidth?: number;
	}
	let { icon, size = 14, strokeWidth = 1.8 }: Props = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width={strokeWidth}
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
>
	{#if icon === 'fox'}
		<path d="M5 4.5c-.9 4.6.1 9.3 7 15.5 6.9-6.2 7.9-10.9 7-15.5l-3.4 4h-7.2z" />
		<path d="M9.5 11.5h.01M14.5 11.5h.01" stroke-width="2.4" />
		<path d="m11 14.8 1 1.1 1-1.1" />
	{:else if icon === 'badger'}
		<circle cx="12" cy="13" r="7" />
		<path d="M6.8 7.6C6 6 6.8 4.6 8.4 5M17.2 7.6C18 6 17.2 4.6 15.6 5" />
		<path d="M9.5 7v4M14.5 7v4" />
		<path d="M9.5 13.2h.01M14.5 13.2h.01" stroke-width="2.4" />
		<path d="m11.2 16 .8.9.8-.9" />
	{:else if icon === 'rabbit'}
		<path d="M9.3 10.8C7.8 8.6 7.2 4.6 8.8 4c1.5-.5 2.6 3.2 2.5 6.2" />
		<path d="M14.7 10.8c1.5-2.2 2.1-6.2.5-6.8-1.5-.5-2.6 3.2-2.5 6.2" />
		<circle cx="12" cy="15.5" r="5.6" />
		<path d="M9.9 14.9h.01M14.1 14.9h.01" stroke-width="2.4" />
		<path d="m11.2 17.2.8.9.8-.9" />
	{:else if icon === 'cat'}
		<path
			d="M12 5c.7-1.2 1.9-2 3.3-2 .4 1 .5 2.1.2 3.1C16.8 7.4 17.5 9.1 17.5 11c0 4.4-2.5 7-5.5 7s-5.5-2.6-5.5-7c0-1.9.7-3.6 2-4.9-.3-1-.2-2.1.2-3.1C10.1 3 11.3 3.8 12 5Z"
		/>
		<path d="M9.8 10.5h.01M14.2 10.5h.01" stroke-width="2.4" />
	{:else if icon === 'bee'}
		<ellipse cx="12" cy="14" rx="5" ry="6" />
		<path d="M8.4 12h7.2M8.4 16h7.2" />
		<path d="M8 9C5.5 7.5 5 5 6.5 4M16 9c2.5-1.5 3-4 1.5-5" />
	{:else if icon === 'turtle'}
		<path d="M5 14a7 5.5 0 0 1 14 0z" />
		<path d="M5 14h14M9 9.5 8 14M15 9.5 16 14" />
		<path d="M19 14c1.6 0 2.5-1 2.5-2.4" />
		<path d="M6 14l-1.5 3M18 14l1.5 3M10 14v3.2M14 14v3.2" />
	{:else if icon === 'ghost'}
		<path d="M5 11a7 7 0 0 1 14 0v9l-2.3-1.9L14.4 20 12 18.1 9.6 20l-2.3-1.9L5 20z" />
		<path d="M9.5 10.5h.01M14.5 10.5h.01" stroke-width="2.4" />
	{:else}
		<!-- owl (default) -->
		<path d="M7.5 4.5 9 7M16.5 4.5 15 7" />
		<circle cx="12" cy="12.5" r="7.5" />
		<path d="M9.4 11.4h.01M14.6 11.4h.01" stroke-width="2.4" />
		<path d="m12 14.4-1.2 1.9h2.4z" />
	{/if}
</svg>
