<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { env } from '$env/dynamic/public';
	import { createBrowserClerk } from '$lib/clerk-client';
	import type { Clerk as ClerkType } from '@clerk/clerk-js';

	let buttonHost = $state<HTMLDivElement>();
	let clerk: ClerkType | null = null;
	let visible = $state(false);

	onMount(async () => {
		if (!env.PUBLIC_CLERK_PUBLISHABLE_KEY || location.pathname === '/sign-in') return;

		clerk = await createBrowserClerk(env.PUBLIC_CLERK_PUBLISHABLE_KEY);

		if (clerk.user && buttonHost) {
			clerk.mountUserButton(buttonHost);
			visible = true;
		}
	});

	onDestroy(() => {
		if (clerk && buttonHost) clerk.unmountUserButton(buttonHost);
	});
</script>

<div class="clerk-user-button" class:visible bind:this={buttonHost}></div>

<style>
	.clerk-user-button {
		position: fixed;
		top: 12px;
		right: 12px;
		z-index: 10000;
		display: none;
	}

	.clerk-user-button.visible {
		display: block;
	}
</style>
