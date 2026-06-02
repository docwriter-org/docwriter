<script lang="ts">
	import { onMount } from 'svelte';

	let emailValue = $state('');
	let submitted = $state(false);
	let submitting = $state(false);
	let errorMsg = $state('');

	// Rough-notation for hand-drawn highlights
	let highlightEl: HTMLSpanElement | null = $state(null);
	let underlineEl: HTMLSpanElement | null = $state(null);
	let mounted = $state(false);

	onMount(async () => {
		mounted = true;
		const { annotate } = await import('rough-notation');
		await new Promise((r) => setTimeout(r, 600));
		if (highlightEl) {
			const a = annotate(highlightEl, {
				type: 'highlight',
				color: 'rgba(42, 119, 101, 0.18)',
				strokeWidth: 2,
				iterations: 2,
				animate: true,
				animationDuration: 1200,
				multiline: true
			});
			a.show();
		}
		if (underlineEl) {
			const a = annotate(underlineEl, {
				type: 'underline',
				color: '#c45d4c',
				strokeWidth: 2,
				iterations: 1,
				animate: true,
				animationDuration: 800,
				multiline: true
			});
			a.show();
		}
	});

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (!emailValue.trim() || submitting) return;
		submitting = true;
		errorMsg = '';
		try {
			const res = await fetch('/api/waitlist', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: emailValue.trim() })
			});
			if (res.ok) {
				submitted = true;
			} else {
				const data = await res.json().catch(() => ({}));
				errorMsg = data.error || 'Something went wrong. Please try again.';
			}
		} catch {
			errorMsg = 'Network error. Please try again.';
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title>DocWriter - Your draft is the interface</title>
	<meta
		name="description"
		content="An AI writing editor where instructions live inside your draft. Write, steer, and review agent edits without ever leaving the page."
	/>
</svelte:head>

<div class="landing" class:mounted>
	<!-- Nav -->
	<nav class="nav">
		<div class="nav-brand">
			<div class="mark">D</div>
			<span class="wordmark">DocWriter</span>
		</div>
		<a href="/sign-in" class="nav-signin">Sign in</a>
	</nav>

	<!-- Hero -->
	<section class="hero">
		<p class="kicker">A writing editor with an AI side-channel</p>
		<h1>
			Your draft is<br />
			<span bind:this={highlightEl} class="hl">the interface.</span>
		</h1>
		<p class="subtitle">
			Drop an instruction beside any passage and the agent
			rewrites it in place. No chat window, no copy-paste &mdash;
			<span bind:this={underlineEl} class="ul">context and control stay where you write.</span>
		</p>
	</section>

	<!-- Demo card -->
	<section class="demo-section">
		<div class="demo-card">
			<div class="demo-editor">
				<div class="demo-line faint">The results suggest a correlation between</div>
				<div class="demo-line faint">input diversity and model robustness, though</div>
				<div class="demo-line faint">the mechanism is not fully understood.</div>
				<div class="demo-line">&nbsp;</div>
				<div class="demo-line instruction">
					<span class="bracket">[[ </span>make this argument sharper and cite the Wang et al. finding<span class="bracket"> ]]</span>
				</div>
				<div class="demo-line">&nbsp;</div>
				<div class="demo-line faint">Further experiments should examine whether</div>
				<div class="demo-line faint">this effect generalizes across architectures.</div>
			</div>
			<div class="demo-agent">
				<div class="agent-header">
					<div class="agent-dot"></div>
					Agent edit
				</div>
				<div class="agent-body">
					<div class="agent-label">read_doc &rarr; edit_doc</div>
					<div class="agent-suggestion">
						The results <span class="diff-add">demonstrate a statistically significant</span> correlation between
						input diversity and model robustness<span class="diff-add">, consistent with Wang et al.&rsquo;s (2024)
						finding that heterogeneous training distributions improve out-of-distribution
						generalization by 12&ndash;18%</span>.
					</div>
					<div class="agent-actions">
						<button class="action-btn accept" type="button">Accept</button>
						<button class="action-btn reject" type="button">Reject</button>
					</div>
				</div>
			</div>
		</div>
	</section>

	<!-- Features -->
	<section class="features">
		<div class="feature">
			<div class="feature-icon">&#9998;</div>
			<h3>Inline instructions</h3>
			<p>Write <code>[[ ... ]]</code> anywhere in your draft. The agent reads the surrounding context and makes the edit right there.</p>
		</div>
		<div class="feature">
			<div class="feature-icon">&#128203;</div>
			<h3>Track changes</h3>
			<p>Every agent edit shows as a reviewable diff. Accept, reject, or retry with feedback &mdash; just like working with a co-author.</p>
		</div>
		<div class="feature">
			<div class="feature-icon">&#128196;</div>
			<h3>Plain markdown</h3>
			<p>Your files stay as .md on disk. No lock-in, no proprietary format. Git-friendly, portable, yours.</p>
		</div>
	</section>

	<!-- How it's different -->
	<section class="difference">
		<h2>Not another AI chat window.</h2>
		<p>
			Most AI writing tools bolt a chatbot onto a text editor. You copy a paragraph out,
			prompt for changes, copy it back. DocWriter inverts this: your draft <em>is</em> the
			prompt. The agent reads the document, sees your instructions in context, and transacts
			edits through a live collaborative document &mdash; the same CRDT your cursor is on.
		</p>
	</section>

	<!-- Waitlist -->
	<section class="waitlist" id="waitlist">
		<h2>Get early access</h2>
		<p>DocWriter is in private beta. Drop your email and we&rsquo;ll let you in.</p>
		{#if submitted}
			<div class="success-msg">
				<span class="success-check">&#10003;</span>
				You&rsquo;re on the list. We&rsquo;ll be in touch.
			</div>
		{:else}
			<form class="waitlist-form" onsubmit={handleSubmit}>
				<input
					type="email"
					placeholder="you@example.com"
					bind:value={emailValue}
					required
					class="email-input"
				/>
				<button type="submit" class="submit-btn" disabled={submitting}>
					{submitting ? 'Joining...' : 'Join waitlist'}
				</button>
			</form>
			{#if errorMsg}
				<p class="error-msg">{errorMsg}</p>
			{/if}
		{/if}
	</section>

	<!-- Footer -->
	<footer class="footer">
		<span class="footer-brand">DocWriter</span>
		<span class="footer-sep">&middot;</span>
		<span>Your draft is the interface.</span>
	</footer>
</div>

<style>
	:global(body) {
		margin: 0;
		background: #faf8f4;
		overflow-x: hidden;
	}

	.landing {
		min-height: 100vh;
		font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		color: #1d2724;
		background:
			radial-gradient(ellipse at 20% 0%, rgba(42, 119, 101, 0.10), transparent 50%),
			radial-gradient(ellipse at 80% 10%, rgba(196, 93, 76, 0.07), transparent 40%),
			radial-gradient(ellipse at 50% 100%, rgba(42, 119, 101, 0.06), transparent 50%),
			#faf8f4;
		opacity: 0;
		transition: opacity 400ms ease;
	}
	.landing.mounted {
		opacity: 1;
	}

	/* Nav */
	.nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		max-width: 960px;
		margin: 0 auto;
		padding: 24px 28px;
	}
	.nav-brand {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.mark {
		width: 36px;
		height: 36px;
		display: grid;
		place-items: center;
		border-radius: 8px;
		background: #245f55;
		color: white;
		font-weight: 700;
		font-size: 17px;
		font-family: 'Lora', Georgia, serif;
	}
	.wordmark {
		font-family: 'Lora', Georgia, serif;
		font-size: 20px;
		font-weight: 600;
		letter-spacing: -0.01em;
	}
	.nav-signin {
		font-size: 14px;
		font-weight: 500;
		color: #245f55;
		text-decoration: none;
		padding: 7px 16px;
		border: 1px solid #c5d4cf;
		border-radius: 6px;
		transition: background 150ms ease;
	}
	.nav-signin:hover {
		background: rgba(36, 95, 85, 0.06);
	}

	/* Hero */
	.hero {
		max-width: 700px;
		margin: 48px auto 0;
		padding: 0 28px;
		text-align: center;
	}
	.kicker {
		margin: 0 0 16px;
		font-size: 14px;
		font-weight: 500;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: #245f55;
	}
	h1 {
		margin: 0 0 24px;
		font-family: 'Lora', Georgia, serif;
		font-size: clamp(38px, 6vw, 56px);
		font-weight: 700;
		line-height: 1.08;
		letter-spacing: -0.02em;
		color: #14151f;
	}
	.hl {
		display: inline-block;
		position: relative;
	}
	.ul {
		display: inline;
		position: relative;
	}
	.subtitle {
		margin: 0;
		font-size: 18px;
		line-height: 1.6;
		color: #4a5550;
		max-width: 560px;
		margin: 0 auto;
	}

	/* Demo card */
	.demo-section {
		max-width: 820px;
		margin: 56px auto 0;
		padding: 0 28px;
	}
	.demo-card {
		display: grid;
		grid-template-columns: 1fr 320px;
		gap: 0;
		border: 1px solid rgba(20, 21, 31, 0.09);
		border-radius: 16px;
		background: #fffdf9;
		box-shadow:
			0 24px 80px rgba(20, 21, 31, 0.10),
			0 1px 0 rgba(255, 255, 255, 0.8) inset;
		overflow: hidden;
	}
	.demo-editor {
		padding: 36px 32px;
		font-family: 'Lora', Georgia, serif;
		font-size: 15px;
		line-height: 1.8;
		color: #1f2937;
		border-right: 1px solid rgba(20, 21, 31, 0.07);
	}
	.demo-line.faint {
		color: #8b9299;
	}
	.demo-line.instruction {
		color: #5b3aa0;
		font-family: 'Geist Mono', 'SFMono-Regular', Consolas, monospace;
		font-size: 13.5px;
		font-weight: 500;
		background: rgba(109, 40, 217, 0.06);
		border-radius: 4px;
		padding: 2px 4px;
		margin: 2px -4px;
	}
	.bracket {
		color: #8b6cc4;
		font-weight: 600;
	}
	.demo-agent {
		padding: 24px 22px;
		background: rgba(250, 248, 244, 0.6);
	}
	.agent-header {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #245f55;
		margin-bottom: 16px;
	}
	.agent-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #2a7765;
		animation: pulse 2s ease-in-out infinite;
	}
	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}
	.agent-label {
		font-family: 'Geist Mono', 'SFMono-Regular', Consolas, monospace;
		font-size: 11px;
		color: #8b9299;
		margin-bottom: 10px;
	}
	.agent-suggestion {
		font-size: 13.5px;
		line-height: 1.65;
		color: #344054;
		padding: 14px;
		background: rgba(42, 119, 101, 0.05);
		border-radius: 8px;
		border: 1px solid rgba(42, 119, 101, 0.12);
	}
	.diff-add {
		background: rgba(5, 150, 105, 0.12);
		color: #065f46;
		border-radius: 2px;
		padding: 0 2px;
	}
	.agent-body {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.agent-actions {
		display: flex;
		gap: 8px;
		margin-top: 12px;
	}
	.action-btn {
		flex: 1;
		padding: 8px 0;
		border-radius: 6px;
		font-size: 13px;
		font-weight: 600;
		cursor: default;
		border: none;
		font-family: inherit;
	}
	.action-btn.accept {
		background: #245f55;
		color: white;
	}
	.action-btn.reject {
		background: transparent;
		border: 1px solid #c5d4cf;
		color: #4a5550;
	}

	/* Features */
	.features {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 24px;
		max-width: 820px;
		margin: 72px auto 0;
		padding: 0 28px;
	}
	.feature {
		padding: 24px 20px;
		border-radius: 12px;
		border: 1px solid rgba(20, 21, 31, 0.06);
		background: rgba(255, 253, 249, 0.7);
	}
	.feature-icon {
		font-size: 24px;
		margin-bottom: 10px;
	}
	.feature h3 {
		margin: 0 0 8px;
		font-family: 'Lora', Georgia, serif;
		font-size: 17px;
		font-weight: 600;
		color: #14151f;
	}
	.feature p {
		margin: 0;
		font-size: 14px;
		line-height: 1.6;
		color: #4a5550;
	}
	.feature code {
		font-family: 'Geist Mono', 'SFMono-Regular', Consolas, monospace;
		font-size: 13px;
		background: rgba(109, 40, 217, 0.07);
		padding: 1px 5px;
		border-radius: 3px;
		color: #5b3aa0;
	}

	/* Difference */
	.difference {
		max-width: 620px;
		margin: 72px auto 0;
		padding: 0 28px;
		text-align: center;
	}
	.difference h2 {
		margin: 0 0 16px;
		font-family: 'Lora', Georgia, serif;
		font-size: 28px;
		font-weight: 700;
		color: #14151f;
	}
	.difference p {
		margin: 0;
		font-size: 16px;
		line-height: 1.7;
		color: #4a5550;
	}
	.difference em {
		font-style: italic;
		color: #245f55;
		font-weight: 500;
	}

	/* Waitlist */
	.waitlist {
		max-width: 480px;
		margin: 80px auto 0;
		padding: 0 28px;
		text-align: center;
	}
	.waitlist h2 {
		margin: 0 0 8px;
		font-family: 'Lora', Georgia, serif;
		font-size: 28px;
		font-weight: 700;
		color: #14151f;
	}
	.waitlist p {
		margin: 0 0 24px;
		font-size: 15px;
		line-height: 1.6;
		color: #4a5550;
	}
	.waitlist-form {
		display: flex;
		gap: 8px;
		max-width: 420px;
		margin: 0 auto;
	}
	.email-input {
		flex: 1;
		padding: 12px 14px;
		font-family: inherit;
		font-size: 15px;
		border: 1px solid #c5d4cf;
		border-radius: 8px;
		background: white;
		color: #1d2724;
		outline: none;
		transition: border-color 150ms ease;
	}
	.email-input:focus {
		border-color: #245f55;
		box-shadow: 0 0 0 3px rgba(36, 95, 85, 0.10);
	}
	.email-input::placeholder {
		color: #a0aaa6;
	}
	.submit-btn {
		padding: 12px 24px;
		font-family: inherit;
		font-size: 15px;
		font-weight: 600;
		background: #245f55;
		color: white;
		border: none;
		border-radius: 8px;
		cursor: pointer;
		white-space: nowrap;
		transition: background 150ms ease;
	}
	.submit-btn:hover {
		background: #1d4e46;
	}
	.submit-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.success-msg {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 14px 22px;
		border-radius: 8px;
		background: rgba(42, 119, 101, 0.08);
		border: 1px solid rgba(42, 119, 101, 0.18);
		font-size: 15px;
		font-weight: 500;
		color: #245f55;
	}
	.success-check {
		font-size: 18px;
		font-weight: 700;
	}
	.error-msg {
		margin: 10px 0 0;
		font-size: 14px;
		color: #c45d4c;
	}

	/* Footer */
	.footer {
		max-width: 960px;
		margin: 80px auto 0;
		padding: 28px 28px 36px;
		text-align: center;
		font-size: 13px;
		color: #8b9299;
		border-top: 1px solid rgba(20, 21, 31, 0.06);
	}
	.footer-brand {
		font-family: 'Lora', Georgia, serif;
		font-weight: 600;
		color: #4a5550;
	}
	.footer-sep {
		margin: 0 6px;
	}

	/* Responsive */
	@media (max-width: 720px) {
		.demo-card {
			grid-template-columns: 1fr;
		}
		.demo-editor {
			border-right: none;
			border-bottom: 1px solid rgba(20, 21, 31, 0.07);
		}
		.features {
			grid-template-columns: 1fr;
		}
		.waitlist-form {
			flex-direction: column;
		}
	}
</style>
