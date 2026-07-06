<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { env } from '$env/dynamic/public';
	import { IS_HOSTED } from '$lib/hosted';
	import { createBrowserClerk } from '$lib/clerk-client';
	import { stripClerkParams } from '$lib/shared/clerk-params';
	import LogoMark from '$lib/components/LogoMark.svelte';
	import type { Clerk as ClerkType } from '@clerk/clerk-js';

	let signInHost = $state<HTMLDivElement>();
	let clerk: ClerkType | null = null;
	let unlisten: (() => void) | null = null;
	let errorMessage = $state('');
	let infoMessage = $state('');

	// Only same-origin paths are accepted — this guard prevents open redirects.
	function localRedirectPath(value: string | null | undefined, fallback: string): string {
		if (!value) return fallback;
		try {
			const target = stripClerkParams(new URL(value, location.origin));
			if (target.origin !== location.origin) return fallback;
			return `${target.pathname}${target.search}${target.hash}` || fallback;
		} catch {
			return fallback;
		}
	}

	// Honor ?redirect_url when present (origin-checked above); otherwise land on
	// '/' in hosted mode or '/welcome' on landing deploys.
	function redirectTarget(): string {
		const fallback = IS_HOSTED ? '/' : '/welcome';
		const requested = new URL(location.href).searchParams.get('redirect_url');
		return localRedirectPath(requested, fallback);
	}

	type AuthorizationState = 'authorized' | 'signed-out' | 'forbidden';

	async function authorizationState(clerkInstance: ClerkType): Promise<AuthorizationState> {
		const res = await fetch('/api/auth/status');
		if (!res.ok) return 'signed-out';
		const body = (await res.json()) as { authenticated?: boolean; authorized?: boolean };
		if (body.authenticated && !body.authorized) {
			await clerkInstance.signOut();
			errorMessage = 'This login is only for invited user study participants.';
			return 'forbidden';
		}
		if (body.authorized === true) return 'authorized';
		return 'signed-out';
	}

	function mountSignIn(target: string): void {
		if (!signInHost || !clerk) return;
		clerk.mountSignIn(signInHost, {
			forceRedirectUrl: target,
			routing: 'hash',
			signUpForceRedirectUrl: target,
			signUpUrl: '/sign-in'
		});
	}

	onMount(async () => {
		const url = new URL(location.href);
		if (url.searchParams.get('denied') === '1') {
			infoMessage = 'That account is not on the invite list for this study.';
		}

		if (!env.PUBLIC_CLERK_PUBLISHABLE_KEY) {
			errorMessage = 'Sign-in is not configured on this deployment.';
			return;
		}

		try {
			clerk = await createBrowserClerk(env.PUBLIC_CLERK_PUBLISHABLE_KEY);
			const target = redirectTarget();

			if (clerk.user) {
				if ((await authorizationState(clerk)) === 'authorized') {
					location.href = target;
					return;
				}
				await clerk.signOut().catch(() => undefined);
			}

			mountSignIn(target);

			unlisten = clerk.addListener(async (resources) => {
				if (!resources.user || !clerk) return;
				if ((await authorizationState(clerk)) === 'authorized') {
					location.href = target;
				}
			});
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Unable to load sign-in.';
		}
	});

	onDestroy(() => {
		unlisten?.();
		if (clerk && signInHost) clerk.unmountSignIn(signInHost);
	});
</script>

<svelte:head>
	<title>User study sign-in — DocWriter</title>
</svelte:head>

<main class="auth-page">
	<section class="auth-shell" aria-label="User study sign-in">
		<div class="brand">
			<LogoMark size={44} interactive={false} />
			<div>
				<h1>DocWriter</h1>
				<p>Sign in for the private user study.</p>
			</div>
		</div>

		{#if infoMessage}
			<p class="info">{infoMessage}</p>
		{/if}

		{#if errorMessage}
			<p class="error">{errorMessage}</p>
		{/if}

		<div class="sign-in-card" bind:this={signInHost}></div>
	</section>
</main>

<style>
	:global(body) {
		margin: 0;
		background: #faf9f6;
	}

	.auth-page {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: 32px 18px;
		font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		color: #1a1a1a;
		background: #faf9f6;
	}

	.auth-shell {
		width: min(100%, 450px);
		display: grid;
		gap: 18px;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 14px;
	}

	h1,
	p {
		margin: 0;
	}

	h1 {
		font-family: 'Lora', Georgia, serif;
		font-size: 24px;
		line-height: 1.1;
	}

	.brand p {
		margin-top: 4px;
		color: #555;
		font-size: 14px;
	}

	.sign-in-card {
		min-height: 440px;
	}

	.info {
		padding: 10px 12px;
		border: 1px solid #e8e5de;
		border-radius: 6px;
		background: #fff;
		color: #555;
		font-size: 14px;
		line-height: 1.5;
	}

	.error {
		padding: 10px 12px;
		border: 1px solid #e8b4b4;
		border-radius: 6px;
		background: #fff5f5;
		color: #9d2d20;
		font-size: 14px;
		line-height: 1.5;
	}
</style>
