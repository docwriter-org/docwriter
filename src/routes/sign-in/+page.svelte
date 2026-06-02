<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { env } from '$env/dynamic/public';
	import { createBrowserClerk } from '$lib/clerk-client';
	import type { Clerk as ClerkType } from '@clerk/clerk-js';

	let signInHost = $state<HTMLDivElement>();
	let clerk: ClerkType | null = null;
	let errorMessage = $state('');

	function redirectTarget(): string {
		const url = new URL(location.href);
		const requested = url.searchParams.get('redirect_url');
		if (!requested) return '/';

		try {
			const target = new URL(requested, location.origin);
			if (target.origin !== location.origin) return '/';
			return `${target.pathname}${target.search}${target.hash}` || '/';
		} catch {
			return '/';
		}
	}

	onMount(async () => {
		if (!env.PUBLIC_CLERK_PUBLISHABLE_KEY) {
			errorMessage = 'Missing PUBLIC_CLERK_PUBLISHABLE_KEY.';
			return;
		}

		try {
			clerk = await createBrowserClerk(env.PUBLIC_CLERK_PUBLISHABLE_KEY);
			const target = redirectTarget();

			if (clerk.user) {
				location.href = target;
				return;
			}

			if (signInHost) {
				clerk.mountSignIn(signInHost, {
					fallbackRedirectUrl: target,
					forceRedirectUrl: target,
					routing: 'hash',
					signUpUrl: '/sign-in'
				});
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Unable to load Clerk.';
		}
	});

	onDestroy(() => {
		if (clerk && signInHost) clerk.unmountSignIn(signInHost);
	});
</script>

<svelte:head>
	<title>Sign in - DocWriter</title>
</svelte:head>

<main class="auth-page">
	<section class="auth-shell" aria-label="Sign in">
		<div class="brand">
			<div class="mark">D</div>
			<div>
				<h1>DocWriter</h1>
				<p>Sign in to continue.</p>
			</div>
		</div>

		{#if errorMessage}
			<p class="error">{errorMessage}</p>
		{/if}

		<div class="sign-in-card" bind:this={signInHost}></div>
	</section>
</main>

<style>
	:global(body) {
		margin: 0;
		background: #f6f2ea;
	}

	.auth-page {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: 32px 18px;
		font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		color: #1d2724;
		background:
			linear-gradient(120deg, rgba(42, 119, 101, 0.16), transparent 42%),
			linear-gradient(300deg, rgba(205, 89, 73, 0.13), transparent 46%),
			#f6f2ea;
	}

	.auth-shell {
		width: min(100%, 450px);
		display: grid;
		gap: 22px;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 14px;
	}

	.mark {
		width: 44px;
		height: 44px;
		display: grid;
		place-items: center;
		border-radius: 8px;
		background: #245f55;
		color: white;
		font-weight: 700;
		font-size: 20px;
	}

	h1,
	p {
		margin: 0;
	}

	h1 {
		font-size: 24px;
		line-height: 1.1;
		letter-spacing: 0;
	}

	.brand p {
		margin-top: 4px;
		color: #5d6763;
		font-size: 14px;
	}

	.sign-in-card {
		min-height: 440px;
	}

	.error {
		padding: 10px 12px;
		border: 1px solid #d88a7e;
		border-radius: 6px;
		background: #fff5f2;
		color: #9d2d20;
		font-size: 14px;
	}
</style>
