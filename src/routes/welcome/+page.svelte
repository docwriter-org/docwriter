<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import type { PageData } from './$types';
	import LogoMark from '$lib/components/LogoMark.svelte';

	interface Props {
		data: PageData;
	}
	let { data }: Props = $props();

	let projects = $state(untrack(() => data.projects));

	let phase = $state(0);
	let typedChars = $state(0);

	const directive = '[[ include a citation for Rayleigh scattering ]]';
	const userTyping = 'The atmosphere scatters shorter wavelengths more than';

	// 0: typing the directive on line 6
	// 1: directive done, now user types on line 8 while agent processes
	//    midway through typing, agent strikes through directive + pill appears
	// 2: popover expands
	// 3: accept → clean text
	// → back to 0

	onMount(() => {
		const controller = new AbortController();
		for (const project of projects) {
			fetch(`https://api.github.com/repos/${project.repo}`, {
				headers: { Accept: 'application/vnd.github+json' },
				signal: controller.signal
			})
				.then((res) => (res.ok ? res.json() : null))
				.then((body) => {
					if (Number.isInteger(body?.stargazers_count) && body.stargazers_count >= 0) {
						projects = projects.map((item) => item.repo === project.repo
							? { ...item, stars: body.stargazers_count } : item);
					}
				})
				.catch(() => {});
		}

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

		function goPhase2() { phase = 2; timer = setTimeout(goPhase3, 4000); }
		function goPhase3() { phase = 3; timer = setTimeout(startDirective, 3000); }

		timer = setTimeout(startDirective, 2000);
		return () => { controller.abort(); clearTimeout(timer); clearInterval(typeInterval); };
	});

	let directiveText = $derived(phase === 0 ? directive.slice(0, typedChars) : directive);
	let userText = $derived(phase >= 1 ? userTyping.slice(0, phase === 1 ? typedChars : userTyping.length) : '');
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
	<meta name="description" content="A real-time, async document editor for humans and agents." />
</svelte:head>

<div class="page">
	<header class="hero">
		<h1><LogoMark size={44} />DocWriter</h1>
		<p class="subtitle">A real-time, async document editor for humans and agents.</p>
		<p class="attribution">A project from <span>Full Stack Data Lab</span></p>
		<div class="project-links" aria-label="Project resources">
			{#each projects as project}
				<a href={`https://github.com/${project.repo}`} class="project-link" target="_blank" rel="noopener noreferrer">
					<span class="project-label">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
							<path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.6.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3Z" />
						</svg>
						{project.label}<span class="sr-only"> on GitHub</span>
					</span>
					<span class="project-stars" aria-label={project.stars === null ? 'Star on GitHub' : `${project.stars} GitHub stars`}>
						<span aria-hidden="true">★</span> {project.stars === null ? 'Star' : project.stars.toLocaleString('en-US')}
					</span>
				</a>
			{/each}
			<a class="project-link" href="https://docs.docwriter.org">Documentation</a>
		</div>
	</header>

	<!-- Animated demo -->
	<figure class="demo-wrap" role="img" aria-label="Animated DocWriter demo: a writer types an instruction to add a citation, then continues writing while the agent works. The agent proposes replacement text with a citation. The proposed edit appears inline for review, and the animation shows it being accepted.">
		<div class="demo-window" inert aria-hidden="true">
			<div class="demo-titlebar">
				<div class="tb-left">
					<span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
					<span class="tb-logo">DocWriter</span>
					<span class="tb-link">Settings</span>
				</div>
				<div class="tb-right">
					<span class="tb-link">Sidebar</span>
				</div>
			</div>
			<!-- Rules bar -->
			<div class="rules-bar">
				<span class="rule-pill">No passive voice</span>
				<span class="rule-pill">Keep paragraphs under 3 sentences</span>
				<span class="rule-pill">Use active verbs</span>
				<span class="rule-pill muted">+2 more</span>
			</div>
			<div class="demo-body">
				<!-- Left sidebar -->
				<div class="demo-left">
					<div class="section-label">OUTLINE</div>
					<div class="outline-item">Why the Sky Turns Blue</div>
					<div class="spacer"></div>
					<div class="section-label">FILES</div>
					<div class="file">.docwriter</div>
					<div class="file active">blog-post.md</div>
				</div>

				<!-- Editor area -->
				<div class="demo-editor-area">
					<div class="tab-bar">
						<div class="tab active">blog-post.md{#if showPill}<span class="tab-dot"></span>{/if}</div>
					</div>
					<div class="editor" role="presentation">
						<div class="el"><span class="ln">1</span><span class="t heading"># Why the Sky Turns Blue</span></div>
						<div class="el"><span class="ln">2</span></div>
						<div class="el"><span class="ln">3</span><span class="t">Look up on a clear day and you see blue.</span></div>
						<div class="el"><span class="ln">4</span><span class="t">But sunlight looks white. Where does blue come from?</span></div>
						<div class="el"><span class="ln">5</span></div>
						{#if showCleanText}
							<div class="el"><span class="ln">6</span><span class="t">Sunlight scatters off gas molecules.</span></div>
							<div class="el"><span class="ln">7</span><span class="t">Blue scatters most (Rayleigh, 1871).</span></div>
						{:else}
							<div class="el">
								<span class="ln">6</span>
								{#if agentStruck}
									<span class="t struck">{directive}</span>
								{:else}
									<span class="t">{directiveText}{#if showDirectiveCaret}<span class="caret"></span>{/if}</span>
								{/if}
							</div>
							{#if showPopover}
								<div class="el"><span class="ln"></span><span class="t added">Sunlight scatters off gas molecules.</span></div>
								<div class="el"><span class="ln"></span><span class="t added">Blue scatters most (Rayleigh, 1871).</span></div>
							{/if}
						{/if}
						<div class="el"><span class="ln">{showCleanText ? 8 : (showPopover ? 9 : 7)}</span></div>
						<div class="el"><span class="ln">{showCleanText ? 9 : (showPopover ? 10 : 8)}</span><span class="t">{userText}{#if showUserCaret}<span class="caret"></span>{/if}</span></div>
					</div>

				</div>

				<!-- "Suggested an edit" pill (between editor and agent panel) -->
				{#if showPill && !showPopover}
					<div class="suggest-pill" in:fly={{ y: 4, duration: 300 }} out:fade={{ duration: 150 }}>
						<span class="sp-cat">&#128049;</span>
						<span class="sp-text">Suggested an edit.</span>
						<span class="sp-badge">&#9998;1</span>
					</div>
				{/if}

				<!-- Expanded review popover -->
				{#if showPopover}
					<div class="review-popover" in:fly={{ y: 6, duration: 350 }} out:fade={{ duration: 200 }}>
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
							<span class="rp-resolve">Dismiss</span>
							<button class="rp-send">Send</button>
						</div>
					</div>
				{/if}

				<!-- Agent panel (right side) -->
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
							<div class="ap-msg"><span class="ap-dot green"></span>mcp__docwriter-doc__edit_doc # Why the Sky T...</div>
							<div class="ap-msg"><span class="ap-dot green"></span>Done. I added a citation for Rayleigh sca...</div>
						{:else}
							<div class="ap-msg"><span class="ap-dot gray"></span>No new request, directive, or feedback to ac...</div>
						{/if}
					</div>
				</div>
			</div>
		</div>
	</figure>

	<section class="features" aria-label="How DocWriter works">
		<div>
			<h2>Collaborate <em>in</em> the document</h2>
			<p>Write instructions like <code>[[ add a citation ]]</code> directly in the document, or highlight text and give the agent feedback.</p>
		</div>
		<div>
			<h2>Configure agent autonomy</h2>
			<p>Choose when the agent can suggest changes on its own. You can review and accept or reject every edit.</p>
		</div>
		<div>
			<h2>Configure and extend the harness</h2>
			<p>Add skills, personal writing styles, and hooks to customize how the agent writes and works.</p>
		</div>
	</section>

	<footer class="sponsors" aria-label="Project sponsors">
		<p>Supported by</p>
		<a href="https://www.laude.org/slingshots" target="_blank" rel="noopener noreferrer" aria-label="Laude Institute Slingshots">
			<img src="/sponsors/laude-institute.svg" alt="Laude Institute" width="180" height="77" loading="lazy" />
		</a>
	</footer>
</div>

<style>
	:global(body) {
		margin: 0; background: #faf8fc;
		overflow-x: hidden; overflow-y: auto !important; height: auto !important;
	}
	.page {
		font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		color: #1a1a1a; padding-bottom: 48px;
	}


	.hero { max-width: 780px; margin: 72px auto 0; padding: 0 24px; text-align: center; }
	h1 { display: flex; align-items: center; justify-content: center; gap: 14px; margin: 0 0 18px; font-family: 'Lora', Georgia, serif; font-size: clamp(38px, 5vw, 48px); line-height: 1.15; font-weight: 500; letter-spacing: -0.025em; }
	.subtitle { max-width: 620px; margin: 0 auto; font-family: 'Lora', Georgia, serif; font-size: 18px; line-height: 1.6; color: #55534e; }
	.attribution { margin: 16px 0 0; font-size: 14px; color: #76716a; }
	.attribution span { color: #344859; }
	h1 :global(.dw-logo) { flex-shrink: 0; }
	.project-links { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; margin-top: 22px; }
	.project-link { display: inline-flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 16px; border: 1px solid #c7c3b9; border-radius: 4px; background: #f5f3ed; text-decoration: none; color: #344859; font-family: 'Lora', Georgia, serif; font-size: 14px; font-weight: 500; transition: background 150ms ease, border-color 150ms ease; }
	.project-label { display: inline-flex; align-items: center; gap: 8px; }
	.project-label svg { flex-shrink: 0; }
	.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
	.project-link:hover { background: #ebe8df; border-color: #8d948f; }
	.project-stars { display: inline-flex; align-items: center; gap: 5px; font-family: 'Inter', sans-serif; color: #666158; font-size: 12px; font-variant-numeric: tabular-nums; }
	.project-stars span { color: #b88214; }
	a:focus-visible { outline: 2px solid #344859; outline-offset: 4px; }

	.demo-wrap { max-width: 940px; margin: 42px auto 0; padding: 0 24px; }
	.demo-window { border: 1px solid #d4d1ca; border-radius: 10px; overflow: hidden; background: #fff; box-shadow: none; }
	.demo-titlebar { display: flex; align-items: center; justify-content: space-between; padding: 9px 14px; background: #f5f3ee; border-bottom: 1px solid #d4d1ca; }
	.tb-left, .tb-right { display: flex; align-items: center; gap: 7px; }
	.dot { width: 10px; height: 10px; border-radius: 50%; }
	.dot.r { background: #ec6a5e; } .dot.y { background: #f4bf4f; } .dot.g { background: #61c554; }
	.tb-logo { margin-left: 10px; font-family: 'Lora', Georgia, serif; font-size: 13px; font-weight: 600; color: #333; }
	.tb-link { font-size: 11.5px; color: #888; }

	.rules-bar { display: flex; gap: 6px; padding: 6px 14px; border-bottom: 1px solid #eae7e0; background: #faf8f4; flex-wrap: wrap; }
	.rule-pill { font-size: 10.5px; padding: 3px 10px; border-radius: 4px; background: rgba(109,40,217,0.08); color: #5b21b6; font-weight: 500; white-space: nowrap; }
	.rule-pill.muted { background: rgba(0,0,0,0.04); color: #888; }

	.demo-body { display: grid; grid-template-columns: 130px 1fr 200px; min-height: 320px; position: relative; }

	.demo-left { padding: 0; border-right: 1px solid #eae7e0; font-size: 11.5px; }
	.section-label { font-weight: 600; font-size: 10px; letter-spacing: 0.05em; color: #999; padding: 8px 12px 4px; }
	.outline-item { padding: 2px 12px; color: #444; font-size: 12px; }
	.spacer { height: 12px; }
	.file { padding: 2px 12px; font-family: 'Geist Mono', 'SFMono-Regular', Consolas, monospace; font-size: 11px; color: #555; }
	.file.active { background: rgba(99,102,241,0.06); color: #4f46e5; }

	.demo-editor-area { display: flex; flex-direction: column; position: relative; overflow: hidden; }
	.tab-bar { display: flex; border-bottom: 1px solid #eae7e0; background: #faf8f4; }
	.tab { padding: 7px 14px; font-size: 12px; font-weight: 500; color: #888; border-bottom: 2px solid transparent; font-family: 'Geist Mono', 'SFMono-Regular', Consolas, monospace; }
	.tab.active { color: #1a1a1a; border-bottom-color: #4f46e5; }
	.tab-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #f59e0b; margin-left: 4px; vertical-align: middle; }

	.editor { flex: 1; padding: 12px 0 12px 4px; font-family: 'Geist Mono', 'SFMono-Regular', Consolas, monospace; font-size: 10.5px; line-height: 1.75; overflow: hidden; white-space: nowrap; }
	.el { display: flex; min-height: 1.75em; position: relative; }
	.ln { display: inline-block; width: 22px; text-align: right; padding-right: 10px; font-size: 9.5px; color: #c0bdb6; user-select: none; flex-shrink: 0; line-height: 1.75em; font-variant-numeric: tabular-nums; }
	.t { color: #333; }
	.t.heading { font-weight: 700; }
	.struck { color: #dc2626; text-decoration: line-through; opacity: 0.65; transition: color 0.4s ease, opacity 0.4s ease; }
	.added { color: #059669; transition: opacity 0.4s ease; }

	.caret { display: inline-block; width: 2px; height: 1.1em; background: #333; vertical-align: text-bottom; margin-left: 1px; animation: blink 1s step-end infinite; }
	@keyframes blink { 50% { opacity: 0; } }

	/* Suggest pill (collapsed) */
	.suggest-pill {
		position: absolute; top: 148px; right: 210px;
		display: flex; align-items: center; gap: 6px;
		padding: 7px 10px; border-radius: 8px;
		background: #fff; border: 1px solid #e5e3de;
		box-shadow: 0 2px 12px rgba(0,0,0,0.06);
		font-size: 11px; color: #333; z-index: 5;
	}
	.sp-cat { width: 22px; height: 22px; border-radius: 50%; background: rgba(99,102,241,0.1); display: flex; align-items: center; justify-content: center; font-size: 11px; }
	.sp-text { font-weight: 500; }
	.sp-badge { font-size: 10px; color: #4f46e5; font-weight: 600; }

	/* Review popover */
	.review-popover {
		position: absolute; top: 120px; right: 210px; width: 180px;
		background: #fff; border: 1px solid #e5e3de; border-radius: 10px;
		box-shadow: 0 4px 24px rgba(0,0,0,0.08);
		font-size: 11px; z-index: 10; overflow: hidden;
	}
	@keyframes popIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
	.rp-header { display: flex; align-items: center; gap: 5px; padding: 10px 10px 2px; }
	.rp-cat { width: 18px; height: 18px; border-radius: 50%; background: rgba(99,102,241,0.1); display: flex; align-items: center; justify-content: center; font-size: 10px; }
	.rp-label { font-weight: 700; font-size: 11px; color: #1a1a1a; }
	.rp-time { margin-left: auto; font-size: 9px; color: #bbb; }
	.rp-msg { padding: 2px 10px 8px; color: #555; font-size: 11px; }
	.rp-edits-label { padding: 6px 10px 3px; font-size: 9px; font-weight: 700; color: #dc2626; letter-spacing: 0.03em; text-transform: uppercase; }
	.rp-edit-row { display: flex; align-items: center; gap: 5px; padding: 3px 10px 8px; }
	.rp-num { width: 16px; height: 16px; border-radius: 50%; background: #059669; color: white; font-size: 8px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
	.rp-preview { flex: 1; font-size: 10px; color: #555; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.rp-x, .rp-check { width: 20px; height: 20px; border-radius: 5px; border: 1px solid #ddd; background: #fff; font-size: 10px; display: flex; align-items: center; justify-content: center; cursor: default; }
	.rp-x { color: #666; }
	.rp-check { background: #4f46e5; color: white; border-color: #4f46e5; }
	.rp-reply { display: block; width: calc(100% - 20px); margin: 0 10px 6px; padding: 6px 8px; border: 1px solid #e5e5e5; border-radius: 5px; font-size: 10px; font-family: inherit; color: #999; background: #fafafa; }
	.rp-footer { display: flex; align-items: center; justify-content: space-between; padding: 3px 10px 8px; }
	.rp-resolve { font-size: 10px; color: #999; }
	.rp-send { padding: 4px 10px; border-radius: 5px; background: #4f46e5; color: white; border: none; font-size: 10px; font-weight: 600; font-family: inherit; cursor: default; }

	/* Agent panel (right sidebar) */
	.demo-right {
		border-left: 1px solid #eae7e0; background: #faf8f4; font-size: 11px;
		display: flex; flex-direction: column; overflow: hidden;
	}
	.demo-right.active { background: rgba(99,102,241,0.02); }
	.ap-header { display: flex; align-items: center; gap: 6px; padding: 10px 10px 6px; border-bottom: 1px solid #eae7e0; }
	.ap-cat { font-size: 13px; }
	.ap-label { font-weight: 700; font-size: 10px; letter-spacing: 0.05em; color: #4f46e5; }
	.ap-status { font-size: 12px; font-weight: 700; color: #4f46e5; }
	.ap-zzz { font-size: 10px; color: #aaa; font-style: italic; }
	.ap-actions { margin-left: auto; font-size: 10px; color: #888; }
	.ap-messages { padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
	.ap-msg { display: flex; align-items: flex-start; gap: 5px; font-size: 10.5px; color: #555; line-height: 1.4; }
	.ap-dot { width: 6px; height: 6px; border-radius: 50%; margin-top: 3px; flex-shrink: 0; }
	.ap-dot.green { background: #059669; }
	.ap-dot.gray { background: #ccc; }

	.features { max-width: 680px; margin: 44px auto 0; padding: 0 24px; }
	.features > div + div { margin-top: 26px; }
	.features h2 { margin: 0 0 6px; font-family: 'Lora', Georgia, serif; font-size: 16px; line-height: 1.65; font-weight: 600; }
	.features p { margin: 0; font-size: 14px; line-height: 1.65; color: #666; }
	.features code { font-size: 12px; color: #6d28d9; }

	.sponsors { max-width: 680px; margin: 56px auto 0; padding: 0 24px; text-align: center; }
	.sponsors p { margin: 0 0 12px; font-size: 13px; color: #76716a; }
	.sponsors a { display: inline-flex; border-radius: 4px; }
	.sponsors img { display: block; width: 180px; height: auto; filter: brightness(0); opacity: 0.7; transition: opacity 150ms ease; }
	.sponsors a:hover img { opacity: 1; }

	@media (max-width: 780px) {
		.demo-body { grid-template-columns: 1fr; }
		.demo-left { display: none; }
		.demo-right { display: none; }
		.suggest-pill, .review-popover { right: 16px; }
		.editor { white-space: normal; padding-right: 10px; }
		.t { min-width: 0; overflow-wrap: anywhere; }
	}
	@media (max-width: 520px) {
		.hero { margin-top: 40px; }
		.project-links { flex-direction: column; align-items: center; }
	}
</style>
