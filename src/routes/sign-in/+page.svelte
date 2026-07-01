<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { env } from '$env/dynamic/public';
	import { createBrowserClerk } from '$lib/clerk-client';
	import type { Clerk as ClerkType } from '@clerk/clerk-js';

	let signInHost = $state<HTMLDivElement>();
	let clerk: ClerkType | null = null;
	let unlisten: (() => void) | null = null;
	let errorMessage = $state('');
	let infoMessage = $state('');

	const CLERK_TRANSIENT_PARAMS = [
		'__clerk_handshake',
		'__clerk_handshake_nonce',
		'__clerk_help'
	];

	function defaultRedirectTarget(): string {
		return env.PUBLIC_DOCWRITER_HOSTED === '1' ? '/' : '/welcome';
	}

	function forceRedirectTarget(): string | null {
		return env.PUBLIC_DOCWRITER_HOSTED === '1' ? '/' : null;
	}

	function stripClerkTransientParams(url: URL): void {
		for (const param of CLERK_TRANSIENT_PARAMS) {
			url.searchParams.delete(param);
		}
	}

	function localRedirectPath(value: string | null | undefined, fallback: string): string {
		if (!value) return fallback;
		try {
			const target = new URL(value, location.origin);
			if (target.origin !== location.origin) return fallback;
			stripClerkTransientParams(target);
			return `${target.pathname}${target.search}${target.hash}` || fallback;
		} catch {
			return fallback;
		}
	}

	function redirectTarget(fallback: string): string {
		const url = new URL(location.href);
		const requested = url.searchParams.get('redirect_url');
		return localRedirectPath(requested, fallback);
	}

	function redirectConfig() {
		const fallback = defaultRedirectTarget();
		const force = forceRedirectTarget();
		return {
			target: force ?? redirectTarget(fallback),
			forceRedirectUrl: force,
			fallbackRedirectUrl: fallback
		};
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

	function mountSignIn(config: ReturnType<typeof redirectConfig>): void {
		if (!signInHost || !clerk) return;
		clerk.mountSignIn(signInHost, {
			fallbackRedirectUrl: config.fallbackRedirectUrl,
			forceRedirectUrl: config.forceRedirectUrl,
			routing: 'hash',
			signUpFallbackRedirectUrl: config.fallbackRedirectUrl,
			signUpForceRedirectUrl: config.forceRedirectUrl,
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
			const config = redirectConfig();

			if (clerk.user) {
				if ((await authorizationState(clerk)) === 'authorized') {
					location.href = config.target;
					return;
				}
				await clerk.signOut().catch(() => undefined);
			}

			mountSignIn(config);

			unlisten = clerk.addListener(async (resources) => {
				if (!resources.user || !clerk) return;
				if ((await authorizationState(clerk)) === 'authorized') {
					location.href = config.target;
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
			<img class="mark" src="/docwriter-mark.svg" alt="" />
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

	.mark {
		width: 44px;
		height: 44px;
		border-radius: 8px;
		display: block;
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
