<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { env } from '$env/dynamic/public';
	import { LogOut, UserCircle } from 'lucide-svelte';
	import { createBrowserClerk } from '$lib/clerk-client';
	import type { Clerk as ClerkType } from '@clerk/clerk-js';

	interface AuthStatus {
		authenticated?: boolean;
		authorized?: boolean;
		user?: {
			email?: string | null;
			name?: string | null;
		} | null;
	}

	let root = $state<HTMLDivElement>();
	let clerk: ClerkType | null = null;
	let unsubscribe: (() => void) | null = null;
	let signedIn = $state(false);
	let loaded = $state(false);
	let menuOpen = $state(false);
	let profileReady = $state(false);
	let signingOut = $state(false);
	let accountEmail = $state<string | null>(null);
	let accountName = $state<string | null>(null);
	let hasSeenSignedInUser = false;

	const hosted = env.PUBLIC_DOCWRITER_HOSTED === '1';
	const CLERK_LOAD_TIMEOUT_MS = 6000;
	const CLERK_TRANSIENT_PARAMS = [
		'__clerk_handshake',
		'__clerk_handshake_nonce',
		'__clerk_help'
	];

	function currentPath(): string {
		const url = new URL(location.href);
		for (const param of CLERK_TRANSIENT_PARAMS) {
			url.searchParams.delete(param);
		}
		return `${url.pathname}${url.search}${url.hash}` || '/';
	}

	function signInHref(): string {
		if (typeof location === 'undefined') return '/sign-in';
		return `/sign-in?redirect_url=${encodeURIComponent(currentPath())}`;
	}

	function accountLabel(): string {
		return accountName || accountEmail || 'Account';
	}

	function applyAuthStatus(status: AuthStatus): void {
		signedIn = status.authenticated === true && status.authorized === true;
		accountEmail = status.user?.email ?? null;
		accountName = status.user?.name ?? null;
		hasSeenSignedInUser = hasSeenSignedInUser || signedIn;
	}

	async function loadAuthStatus(): Promise<void> {
		if (!hosted) return;
		try {
			const res = await fetch('/api/auth/status');
			if (!res.ok) return;
			applyAuthStatus((await res.json()) as AuthStatus);
		} catch (err) {
			console.error('Unable to load account status:', err);
		} finally {
			loaded = true;
		}
	}

	function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
		return Promise.race([
			promise,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))
		]);
	}

	async function loadClerk(): Promise<void> {
		if (!hosted || !env.PUBLIC_CLERK_PUBLISHABLE_KEY) {
			return;
		}

		try {
			clerk = await withTimeout(
				createBrowserClerk(env.PUBLIC_CLERK_PUBLISHABLE_KEY).catch((err) => {
					console.error('Unable to load account menu:', err);
					return null;
				}),
				CLERK_LOAD_TIMEOUT_MS
			);
			if (!clerk) return;

			profileReady = !!clerk.user;
			if (clerk.user) {
				signedIn = true;
				hasSeenSignedInUser = true;
			}

			unsubscribe = clerk.addListener(
				(resources) => {
					const hasUser = !!resources.user;
					if (!hasUser && hasSeenSignedInUser) {
						signedIn = false;
						profileReady = false;
						location.href = '/sign-in';
						return;
					}
					if (hasUser) signedIn = true;
					profileReady = hasUser;
					hasSeenSignedInUser = hasSeenSignedInUser || hasUser;
				},
				{ skipInitialEmit: true }
			);
		} catch (err) {
			console.error('Unable to load account menu:', err);
		}
	}

	function handleDocumentPointerDown(event: PointerEvent): void {
		if (!menuOpen || !root || !(event.target instanceof Node)) return;
		if (!root.contains(event.target)) menuOpen = false;
	}

	function handleDocumentKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') menuOpen = false;
	}

	async function openProfile(): Promise<void> {
		if (!clerk || !profileReady) return;
		clerk.openUserProfile();
		menuOpen = false;
	}

	async function signOut(): Promise<void> {
		if (signingOut) return;
		signingOut = true;
		menuOpen = false;
		const redirectUrl = '/sign-in';
		try {
			await fetch('/api/auth/sign-out', { method: 'POST' }).catch(() => undefined);
			await clerk?.signOut({ redirectUrl }).catch(() => undefined);
		} finally {
			location.href = redirectUrl;
		}
	}

	onMount(() => {
		if (!hosted) return;
		void loadAuthStatus();
		void loadClerk();
		document.addEventListener('pointerdown', handleDocumentPointerDown);
		document.addEventListener('keydown', handleDocumentKeydown);
	});

	onDestroy(() => {
		unsubscribe?.();
		if (typeof document === 'undefined') return;
		document.removeEventListener('pointerdown', handleDocumentPointerDown);
		document.removeEventListener('keydown', handleDocumentKeydown);
	});
</script>

{#if hosted}
	<div class="account-control" bind:this={root} aria-label="Account">
		{#if loaded && !signedIn}
			<a class="account-link" href={signInHref()}>
				<UserCircle size={16} />
				<span>Sign in</span>
			</a>
		{:else}
			<button
				class="account-trigger"
				type="button"
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				onclick={() => (menuOpen = !menuOpen)}
			>
				<UserCircle size={16} />
				<span>{loaded ? accountLabel() : 'Account'}</span>
			</button>
			{#if menuOpen}
				<div class="account-menu" role="menu">
					<div class="account-summary">
						<div class="account-title">{accountLabel()}</div>
						{#if accountEmail && accountEmail !== accountLabel()}
							<div class="account-email">{accountEmail}</div>
						{/if}
					</div>
					<button
						class="account-item"
						type="button"
						role="menuitem"
						disabled={!profileReady}
						title={profileReady ? 'Open profile' : 'Profile is still loading'}
						onclick={() => void openProfile()}
					>
						<UserCircle size={15} />
						<span>Profile</span>
					</button>
					<button
						class="account-item"
						type="button"
						role="menuitem"
						disabled={signingOut}
						onclick={() => void signOut()}
					>
						<LogOut size={15} />
						<span>{signingOut ? 'Signing out' : 'Sign out'}</span>
					</button>
				</div>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.account-control {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: flex-end;
		min-width: 92px;
		min-height: 32px;
	}
	.account-trigger,
	.account-link {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-height: 30px;
		padding: 0 10px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--panel-bg);
		color: var(--text);
		font: inherit;
		font-size: 13px;
		font-weight: 600;
		text-decoration: none;
		white-space: nowrap;
		cursor: pointer;
		max-width: 220px;
	}
	.account-trigger span,
	.account-link span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.account-trigger:hover,
	.account-link:hover,
	.account-trigger[aria-expanded='true'] {
		background: var(--hover-bg);
	}
	.account-menu {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 240;
		min-width: 210px;
		padding: 5px;
		border: 1px solid var(--border-light);
		border-radius: 7px;
		background: var(--bg-elevated);
		box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16), 0 2px 6px rgba(0, 0, 0, 0.08);
	}
	.account-summary {
		padding: 8px 9px 7px;
		border-bottom: 1px solid var(--border-light);
		margin-bottom: 4px;
	}
	.account-title {
		font-size: 13px;
		font-weight: 650;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.account-email {
		margin-top: 2px;
		font-size: 12px;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.account-item {
		display: flex;
		align-items: center;
		gap: 7px;
		width: 100%;
		padding: 7px 8px;
		border: none;
		border-radius: 5px;
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: 13px;
		text-align: left;
		cursor: pointer;
	}
	.account-item:hover:not(:disabled) {
		background: var(--hover-bg);
	}
	.account-item:disabled {
		color: var(--text-faint);
		cursor: default;
	}
</style>
