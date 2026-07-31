<script lang="ts">
	import { onMount } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import LogoMark from '$lib/components/LogoMark.svelte';

	let plainWritingStars = $state<number | null>(null);
	let mounted = $state(false);
	let phase = $state(0);
	let typedChars = $state(0);

	const directive = '[[ include a citation for Rayleigh scattering ]]';
	const userTyping = 'The atmosphere scatters shorter wavelengths more than';

	onMount(() => {
		mounted = true;
		fetch('https://api.github.com/repos/docwriter-org/plain-writing-skill', {
			headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'docwriter-landing' }
		})
			.then((res) => (res.ok ? res.json() : null))
			.then((body) => {
				if (body && typeof body.stargazers_count === 'number') {
					plainWritingStars = body.stargazers_count;
				}
			})
			.catch(() => {});

		let timer: ReturnType<typeof setTimeout>;
		let typeInterval: ReturnType<typeof setInterval>;

		function startDirective() {
			phase = 0;
			typedChars = 0;
			let i = 0;
			typeInterval = setInterval(() => {
				i++;
				typedChars = i;
				if (i >= directive.length) {
					clearInterval(typeInterval);
					timer = setTimeout(startUserTyping, 900);
				}
			}, 35);
		}

		function startUserTyping() {
			phase = 1;
			typedChars = 0;
			let i = 0;
			typeInterval = setInterval(() => {
				i++;
				typedChars = i;
				if (i >= userTyping.length) {
					clearInterval(typeInterval);
					timer = setTimeout(goPhase2, 2200);
				}
			}, 45);
		}

		function goPhase2() {
			phase = 2;
			timer = setTimeout(goPhase3, 4000);
		}
		function goPhase3() {
			phase = 3;
			timer = setTimeout(startDirective, 3000);
		}

		timer = setTimeout(startDirective, 2000);
		return () => {
			clearTimeout(timer);
			clearInterval(typeInterval);
		};
	});

	let directiveText = $derived(phase === 0 ? directive.slice(0, typedChars) : directive);
	let userText = $derived(
		phase >= 1 ? userTyping.slice(0, phase === 1 ? typedChars : userTyping.length) : ''
	);
	let agentStruck = $derived(phase >= 1 && typedChars > 15);
	let showPill = $derived(agentStruck && phase < 3);
	let showPopover = $derived(phase === 2);
	let showCleanText = $derived(phase === 3);
	let agentActive = $derived(agentStruck && phase <= 2);
	let showDirectiveCaret = $derived(phase === 0);
	let showUserCaret = $derived(phase === 1);
</script>

<svelte:head>
	<title>DocWriter</title>
	<meta
		name="description"
		content="A shared writing workspace for writers and AI agents."
	/>
</svelte:head>

<div class="page" class:mounted>
	<nav class="nav">
		<span class="logo"><LogoMark size={30} title="DocWriter" />DocWriter</span>
		<a class="nav-link" href="https://docs.docwriter.org">Documentation</a>
	</nav>

	<header class="hero">
		<h1>DocWriter</h1>
		<p class="subtitle">
			<span class="hl">Reimagining AI-assisted writing to let you:</span>
		</p>
		<p class="hero-detail">
			Keep more of your voice and reduce AI slop.<br />
			Work alongside the agent in the same live draft, at the same time.<br />
			Decide whether the agent waits, comments, proposes changes, or edits directly.
		</p>
	</header>

	<section class="demo-wrap">
		<div class="demo-window">
			<div class="demo-titlebar">
				<div class="tb-left">
					<span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
					<span class="tb-logo">DocWriter</span>
					<span class="tb-link">Settings</span>
				</div>
				<div class="tb-right"><span class="tb-link">Sidebar</span></div>
			</div>
			<div class="rules-bar">
				<span class="rule-pill">No passive voice</span>
				<span class="rule-pill">Keep paragraphs under 3 sentences</span>
				<span class="rule-pill">Use active verbs</span>
				<span class="rule-pill muted">+2 more</span>
			</div>
			<div class="demo-body">
				<div class="demo-left">
					<div class="section-label">OUTLINE</div>
					<div class="outline-item">Why the Sky Turns Blue</div>
					<div class="spacer"></div>
					<div class="section-label">FILES</div>
					<div class="file">.docwriter</div>
					<div class="file active">blog-post.md</div>
				</div>

				<div class="demo-editor-area">
					<div class="tab-bar">
						<div class="tab active">
							blog-post.md{#if showPill}<span class="tab-dot"></span>{/if}
						</div>
					</div>
					<div class="editor" role="presentation">
						<div class="el">
							<span class="ln">1</span><span class="t heading"># Why the Sky Turns Blue</span>
						</div>
						<div class="el"><span class="ln">2</span></div>
						<div class="el">
							<span class="ln">3</span><span class="t">Look up on a clear day and you see blue.</span>
						</div>
						<div class="el">
							<span class="ln">4</span><span class="t"
								>But sunlight looks white. Where does blue come from?</span
							>
						</div>
						<div class="el"><span class="ln">5</span></div>
						{#if showCleanText}
							<div class="el">
								<span class="ln">6</span><span class="t">Sunlight scatters off gas molecules.</span>
							</div>
							<div class="el">
								<span class="ln">7</span><span class="t"
									>Blue scatters most (Rayleigh, 1871).</span
								>
							</div>
						{:else}
							<div class="el">
								<span class="ln">6</span>
								{#if agentStruck}
									<span class="t struck">{directive}</span>
								{:else}
									<span class="t"
										>{directiveText}{#if showDirectiveCaret}<span class="caret"></span>{/if}</span
									>
								{/if}
							</div>
							{#if showPopover}
								<div class="el">
									<span class="ln"></span><span class="t added"
										>Sunlight scatters off gas molecules.</span
									>
								</div>
								<div class="el">
									<span class="ln"></span><span class="t added"
										>Blue scatters most (Rayleigh, 1871).</span
									>
								</div>
							{/if}
						{/if}
						<div class="el">
							<span class="ln">{showCleanText ? 8 : showPopover ? 9 : 7}</span>
						</div>
						<div class="el">
							<span class="ln">{showCleanText ? 9 : showPopover ? 10 : 8}</span><span class="t"
								>{userText}{#if showUserCaret}<span class="caret"></span>{/if}</span
							>
						</div>
					</div>
				</div>

				{#if showPill && !showPopover}
					<div
						class="suggest-pill"
						in:fly={{ y: 4, duration: 300 }}
						out:fade={{ duration: 150 }}
					>
						<span class="sp-cat">&#128049;</span>
						<span class="sp-text">Suggested an edit.</span>
						<span class="sp-badge">&#9998;1</span>
					</div>
				{/if}

				{#if showPopover}
					<div
						class="review-popover"
						in:fly={{ y: 6, duration: 350 }}
						out:fade={{ duration: 200 }}
					>
						<div class="rp-header">
							<span class="rp-cat">&#128049;</span>
							<span class="rp-label">Agent</span>
							<span class="rp-time">just now</span>
						</div>
						<div class="rp-msg">Suggested an edit.</div>
						<div class="rp-edits-label">1 PROPOSED EDIT</div>
						<div class="rp-edit-row">
							<span class="rp-num">1</span>
							<span class="rp-preview struck">[[ include a cita...</span>
							<button class="rp-x">&#10005;</button>
							<button class="rp-check">&#10003;</button>
						</div>
						<input class="rp-reply" type="text" placeholder="Reply..." disabled />
						<div class="rp-footer">
							<span class="rp-resolve">Resolve</span>
							<button class="rp-send">Send</button>
						</div>
					</div>
				{/if}

				<div class="demo-right" class:active={agentActive}>
					<div class="ap-header">
						<span class="ap-cat">&#128049;</span>
						<span class="ap-label">AGENT</span>
						{#if agentActive}
							<span class="ap-status">...</span>
						{:else}
							<span class="ap-zzz">&#7611;zz</span>
						{/if}
						<span class="ap-actions">Send &middot; Restart</span>
					</div>
					<div class="ap-messages">
						{#if agentActive}
							<div class="ap-msg">
								<span class="ap-dot green"></span>mcp__docwriter-doc__edit_doc # Why the Sky T...
							</div>
							<div class="ap-msg">
								<span class="ap-dot green"></span>Done. I added a citation for Rayleigh sca...
							</div>
						{:else}
							<div class="ap-msg">
								<span class="ap-dot gray"></span>No new request, directive, or feedback to ac...
							</div>
						{/if}
					</div>
				</div>
			</div>
		</div>
	</section>

	<section class="about">
		<h2>What is DocWriter?</h2>
		<p>
			DocWriter is a local editor where you and an AI agent share one live draft. You can work
			in Markdown, plain text, or LaTeX while the agent reads the same workspace and responds as
			the draft changes.
		</p>
		<p>
			You can communicate in the document by writing <code
				>[[ add a citation to ... ]]</code
			>, selecting text, or replying to a comment. Agent edits appear beside the text for review.
			Chat remains available for requests that do not belong at one place in the draft.
		</p>
		<p>
			DocWriter works with most frontier LLMs and SDKs: Claude Code, Codex, Pi, and others. It
			uses your existing subscriptions, so if you already have one you do not pay extra.
		</p>
		<p>
			DocWriter is an open source research project from
			<a href="https://cs.cmu.edu" target="_blank" rel="noopener">CMU CSD</a>
			and
			<a href="https://eecs.berkeley.edu" target="_blank" rel="noopener"
				>UC Berkeley EECS</a
			>.
		</p>
	</section>

	<section class="research">
		<h2>Research directions</h2>
		<p class="research-intro">
			Writing is more personal and taste driven than coding, and it is harder to evaluate
			mechanically. We need interfaces, evaluation methods, and writing practices built for
			working with AI.
		</p>
		<div class="research-grid">
			<div class="research-card">
				<h3>Harness engineering</h3>
				<p>
					An AI writing harness needs synchronized documents, agent edit tools, skills that
					encode the writer's voice, and hooks and review passes for repeated work.
				</p>
			</div>
			<div class="research-card">
				<h3>Human steering of long tasks</h3>
				<p>
					A paper or book takes many rounds over months. Writers need ways to redirect agents,
					keep quality consistent, and review changes without losing their place in the draft.
				</p>
			</div>
			<div class="research-card">
				<h3>Characterizing slopwords and good practices</h3>
				<p>
					We want open source methods that help researchers and writers identify repeated AI
					writing patterns and track how the patterns change across models.
				</p>
			</div>
		</div>
	</section>

	<section class="start">
		<h2>Try it</h2>
		<div class="try-buttons">
			<div class="try-row">
				<a href="https://docs.docwriter.org" class="install-block">
					<span class="install-label">Read the documentation</span>
				</a>
				<div class="install-block disabled">
					<code>npx docwriter</code> <span class="install-note">(coming soon!)</span>
				</div>
				<a
					href="https://github.com/docwriter-org/plain-writing-skill"
					class="install-block"
					target="_blank"
					rel="noopener"
				>
					<span class="install-label">Plain writing skill</span>
					{#if plainWritingStars !== null}
						<span class="install-stars" aria-label="{plainWritingStars} GitHub stars"
							>★ {plainWritingStars.toLocaleString()}</span
						>
					{/if}
				</a>
			</div>
			<div class="try-row">
				<a
					href="https://github.com/docwriter-org/docwriter"
					class="install-block"
					target="_blank"
					rel="noopener"
				>
					<span class="install-label">DocWriter on GitHub</span>
				</a>
			</div>
		</div>
	</section>

	<section class="involved">
		<h2>Want to get involved?</h2>
		<p>
			We are looking for user study participants. If you are willing to write and publish a blog
			post, paper, or other long form document using DocWriter and share your experience, we
			would love to hear from you.
		</p>
		<p>
			Open an issue in the
			<a href="https://github.com/docwriter-org/docwriter/issues" target="_blank" rel="noopener"
				>DocWriter repository</a
			>.
		</p>
	</section>

	<footer class="footer">
		<span class="footer-name">DocWriter</span>
		<span class="sep">&middot;</span>
		<span>CMU CSD and UC Berkeley EECS</span>
	</footer>
</div>

<style>
	:global(body) {
		margin: 0;
		background: #faf9f6;
		overflow-x: hidden;
		overflow-y: auto !important;
		height: auto !important;
	}
	.page {
		font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		color: #1a1a1a;
		opacity: 0;
		transition: opacity 300ms ease;
	}
	.page.mounted {
		opacity: 1;
	}
	.nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		max-width: 920px;
		margin: 0 auto;
		padding: 20px 24px;
	}
	.logo {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		font-family: 'Lora', Georgia, serif;
		font-size: 20px;
		font-weight: 600;
		color: #1a1a1a;
	}
	.logo :global(.dw-logo) {
		width: 30px;
		height: 30px;
	}
	.nav-link {
		color: #003262;
		font-size: 14px;
		font-weight: 600;
		text-decoration: none;
	}
	.nav-link:hover {
		text-decoration: underline;
	}
	.hero {
		max-width: 640px;
		margin: 52px auto 0;
		padding: 0 24px;
		text-align: center;
	}
	.hl {
		background: rgba(5, 150, 105, 0.1);
		padding: 1px 4px;
		border-radius: 3px;
	}
	h1 {
		margin: 0 0 10px;
		font-family: 'Lora', Georgia, serif;
		font-size: 40px;
		font-weight: 700;
		letter-spacing: -0.02em;
	}
	.subtitle {
		margin: 0;
		font-size: 18px;
		line-height: 1.5;
		color: #333;
		font-style: italic;
	}
	.hero-detail {
		max-width: 590px;
		margin: 14px auto 0;
		color: #555;
		font-size: 15px;
		line-height: 1.65;
	}
	.demo-wrap {
		max-width: 940px;
		margin: 56px auto 0;
		padding: 0 24px;
	}
	.demo-window {
		border: 1px solid #d4d1ca;
		border-radius: 10px;
		overflow: hidden;
		background: #fff;
		box-shadow: 0 6px 32px rgba(0, 0, 0, 0.06);
	}
	.demo-titlebar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 9px 14px;
		background: #f5f3ee;
		border-bottom: 1px solid #d4d1ca;
	}
	.tb-left,
	.tb-right {
		display: flex;
		align-items: center;
		gap: 7px;
	}
	.dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
	}
	.dot.r {
		background: #ec6a5e;
	}
	.dot.y {
		background: #f4bf4f;
	}
	.dot.g {
		background: #61c554;
	}
	.tb-logo {
		margin-left: 10px;
		font-family: 'Lora', Georgia, serif;
		font-size: 13px;
		font-weight: 600;
		color: #333;
	}
	.tb-link {
		font-size: 11.5px;
		color: #888;
	}
	.rules-bar {
		display: flex;
		gap: 6px;
		padding: 6px 14px;
		border-bottom: 1px solid #eae7e0;
		background: #faf8f4;
		flex-wrap: wrap;
	}
	.rule-pill {
		font-size: 10.5px;
		padding: 3px 10px;
		border-radius: 4px;
		background: rgba(109, 40, 217, 0.08);
		color: #5b21b6;
		font-weight: 500;
		white-space: nowrap;
	}
	.rule-pill.muted {
		background: rgba(0, 0, 0, 0.04);
		color: #888;
	}
	.demo-body {
		display: grid;
		grid-template-columns: 130px 1fr 200px;
		min-height: 320px;
		position: relative;
	}
	.demo-left {
		border-right: 1px solid #eae7e0;
		font-size: 11.5px;
	}
	.section-label {
		font-weight: 600;
		font-size: 10px;
		letter-spacing: 0.05em;
		color: #999;
		padding: 8px 12px 4px;
	}
	.outline-item {
		padding: 2px 12px;
		color: #444;
		font-size: 12px;
	}
	.spacer {
		height: 12px;
	}
	.file {
		padding: 2px 12px;
		font-family: 'Geist Mono', 'SFMono-Regular', Consolas, monospace;
		font-size: 11px;
		color: #555;
	}
	.file.active {
		background: rgba(99, 102, 241, 0.06);
		color: #4f46e5;
	}
	.demo-editor-area {
		display: flex;
		flex-direction: column;
		position: relative;
		overflow: hidden;
	}
	.tab-bar {
		display: flex;
		border-bottom: 1px solid #eae7e0;
		background: #faf8f4;
	}
	.tab {
		padding: 7px 14px;
		font-size: 12px;
		font-weight: 500;
		color: #888;
		border-bottom: 2px solid transparent;
		font-family: 'Geist Mono', 'SFMono-Regular', Consolas, monospace;
	}
	.tab.active {
		color: #1a1a1a;
		border-bottom-color: #4f46e5;
	}
	.tab-dot {
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #f59e0b;
		margin-left: 4px;
		vertical-align: middle;
	}
	.editor {
		flex: 1;
		padding: 12px 0 12px 4px;
		font-family: 'Geist Mono', 'SFMono-Regular', Consolas, monospace;
		font-size: 10.5px;
		line-height: 1.75;
		overflow: hidden;
		white-space: nowrap;
	}
	.el {
		display: flex;
		min-height: 1.75em;
		position: relative;
	}
	.ln {
		display: inline-block;
		width: 22px;
		text-align: right;
		padding-right: 10px;
		font-size: 9.5px;
		color: #c0bdb6;
		user-select: none;
		flex-shrink: 0;
		line-height: 1.75em;
		font-variant-numeric: tabular-nums;
	}
	.t {
		color: #333;
	}
	.t.heading {
		font-weight: 700;
	}
	.struck {
		color: #dc2626;
		text-decoration: line-through;
		opacity: 0.65;
	}
	.added {
		color: #059669;
	}
	.caret {
		display: inline-block;
		width: 2px;
		height: 1.1em;
		background: #333;
		vertical-align: text-bottom;
		margin-left: 1px;
		animation: blink 1s step-end infinite;
	}
	@keyframes blink {
		50% {
			opacity: 0;
		}
	}
	.suggest-pill {
		position: absolute;
		top: 148px;
		right: 210px;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 7px 10px;
		border-radius: 8px;
		background: #fff;
		border: 1px solid #e5e3de;
		box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
		font-size: 11px;
		color: #333;
		z-index: 5;
	}
	.sp-cat {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		background: rgba(99, 102, 241, 0.1);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 11px;
	}
	.sp-text {
		font-weight: 500;
	}
	.sp-badge {
		font-size: 10px;
		color: #4f46e5;
		font-weight: 600;
	}
	.review-popover {
		position: absolute;
		top: 120px;
		right: 210px;
		width: 180px;
		background: #fff;
		border: 1px solid #e5e3de;
		border-radius: 10px;
		box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
		font-size: 11px;
		z-index: 10;
		overflow: hidden;
	}
	.rp-header {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 10px 10px 2px;
	}
	.rp-cat {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: rgba(99, 102, 241, 0.1);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 10px;
	}
	.rp-label {
		font-weight: 700;
	}
	.rp-time {
		margin-left: auto;
		font-size: 9px;
		color: #bbb;
	}
	.rp-msg {
		padding: 2px 10px 8px;
		color: #555;
	}
	.rp-edits-label {
		padding: 6px 10px 3px;
		font-size: 9px;
		font-weight: 700;
		color: #dc2626;
	}
	.rp-edit-row {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 3px 10px 8px;
	}
	.rp-num {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: #059669;
		color: white;
		font-size: 8px;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.rp-preview {
		flex: 1;
		font-size: 10px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rp-x,
	.rp-check {
		width: 20px;
		height: 20px;
		border-radius: 5px;
		border: 1px solid #ddd;
		background: #fff;
		font-size: 10px;
	}
	.rp-check {
		background: #4f46e5;
		color: white;
	}
	.rp-reply {
		display: block;
		width: calc(100% - 20px);
		margin: 0 10px 6px;
		padding: 6px 8px;
		border: 1px solid #e5e5e5;
		border-radius: 5px;
		font-size: 10px;
		background: #fafafa;
	}
	.rp-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 3px 10px 8px;
	}
	.rp-resolve {
		font-size: 10px;
		color: #999;
	}
	.rp-send {
		padding: 4px 10px;
		border-radius: 5px;
		background: #4f46e5;
		color: white;
		border: none;
		font-size: 10px;
	}
	.demo-right {
		border-left: 1px solid #eae7e0;
		background: #faf8f4;
		font-size: 11px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.demo-right.active {
		background: rgba(99, 102, 241, 0.02);
	}
	.ap-header {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 10px 10px 6px;
		border-bottom: 1px solid #eae7e0;
	}
	.ap-cat {
		font-size: 13px;
	}
	.ap-label {
		font-weight: 700;
		font-size: 10px;
		color: #4f46e5;
	}
	.ap-status {
		color: #4f46e5;
	}
	.ap-zzz {
		font-size: 10px;
		color: #aaa;
		font-style: italic;
	}
	.ap-actions {
		margin-left: auto;
		font-size: 10px;
		color: #888;
	}
	.ap-messages {
		padding: 8px 10px;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.ap-msg {
		display: flex;
		align-items: flex-start;
		gap: 5px;
		font-size: 10.5px;
		color: #555;
		line-height: 1.4;
	}
	.ap-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		margin-top: 3px;
		flex-shrink: 0;
	}
	.ap-dot.green {
		background: #059669;
	}
	.ap-dot.gray {
		background: #ccc;
	}
	.about,
	.research,
	.start,
	.involved {
		max-width: 640px;
		margin: 56px auto 0;
		padding: 0 24px;
	}
	.about h2,
	.research h2,
	.start h2,
	.involved h2 {
		font-family: 'Lora', Georgia, serif;
		font-size: 23px;
		font-weight: 600;
		margin: 0 0 12px;
	}
	.about p,
	.research-intro,
	.involved p {
		margin: 0 0 14px;
		font-size: 15px;
		line-height: 1.7;
		color: #444;
	}
	.about code {
		font-family: 'Geist Mono', monospace;
		font-size: 13px;
		background: rgba(109, 40, 217, 0.06);
		padding: 1px 5px;
		border-radius: 3px;
		color: #6d28d9;
	}
	.research-grid {
		display: grid;
		gap: 14px;
	}
	.research-card {
		padding: 18px 20px;
		border: 1px solid #e8e5de;
		border-radius: 8px;
		background: #fff;
	}
	.research-card h3 {
		margin: 0 0 6px;
		font-family: 'Lora', Georgia, serif;
		font-size: 15px;
	}
	.research-card p {
		margin: 0;
		font-size: 14.5px;
		line-height: 1.65;
		color: #555;
	}
	.start {
		text-align: center;
	}
	.try-buttons {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
	}
	.try-row {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 10px;
	}
	.install-block {
		display: inline-block;
		padding: 12px 22px;
		background: #1a1a1a;
		border-radius: 8px;
		text-decoration: none;
		border: none;
	}
	.install-block.disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.install-block code,
	.install-label {
		font-size: 14px;
		color: #e0e0e0;
	}
	.install-stars {
		margin-left: 8px;
		font-size: 13px;
		color: #f4bf4f;
	}
	.install-note {
		font-size: 13px;
		color: #999;
		font-style: italic;
		margin-left: 6px;
	}
	.about a,
	.involved a {
		color: #003262;
		text-decoration: none;
		font-weight: 500;
	}
	.footer {
		max-width: 920px;
		margin: 56px auto 0;
		padding: 22px 24px 32px;
		border-top: 1px solid #e8e5de;
		text-align: center;
		font-size: 13px;
		color: #888;
	}
	.footer-name {
		font-family: 'Lora', Georgia, serif;
		font-weight: 600;
		color: #555;
	}
	.sep {
		margin: 0 6px;
	}
	@media (max-width: 780px) {
		.demo-body {
			grid-template-columns: 1fr;
		}
		.demo-left,
		.demo-right {
			display: none;
		}
	}
	@media (max-width: 520px) {
		.try-row {
			flex-direction: column;
			align-items: center;
		}
	}
</style>
