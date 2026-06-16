<script lang="ts">
	import { onMount } from 'svelte';
	import { fade, fly } from 'svelte/transition';

	let mounted = $state(false);
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
		mounted = true;
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
		return () => { clearTimeout(timer); clearInterval(typeInterval); };
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
	<meta name="description" content="A harness and user interface for AI-assisted writing. A research project from UC Berkeley." />
</svelte:head>

<div class="page" class:mounted>
	<nav class="nav">
		<span class="logo">DocWriter</span>
		<div class="nav-right">
			<a href="https://github.com/shreyashankar/docwriter" class="nav-link" target="_blank" rel="noopener">GitHub</a>
			<a href="/sign-in" class="nav-link">Sign in</a>
		</div>
	</nav>

	<header class="hero">
		<h1>DocWriter</h1>
		<p class="subtitle">A <span class="hl">harness and user interface</span> for AI-assisted writing,<br/>from HCI researchers at UC Berkeley.</p>
	</header>

	<!-- Animated demo -->
	<section class="demo-wrap">
		<div class="demo-window">
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
							<span class="rp-resolve">Resolve</span>
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
	</section>

	<section class="about">
		<h2>What is DocWriter?</h2>
		<p>
			DocWriter is an ongoing research project at UC Berkeley. It is a local editor with a built-in writing agent.
			You can write any files you want&mdash;markdown, plain text, LaTeX&mdash;and the agent collaborates with you, reading your text and comments asynchronously in real time.
		</p>
		<p>
			One of our key UI ideas is to get you <span class="hl">out of the chat</span> when communicating with your agent.
			You communicate inline in the text, e.g., <code>[[ add a citation to ... ]]</code>, or highlight text and leave comments or suggestions for the agent to address.
			Every edit the agent makes appears in place, and you review it inline before it takes effect.
		</p>
		<p>
			DocWriter works with most frontier LLMs and SDKs: Claude Code, Codex, Pi, and others. It uses your existing subscriptions, so if you already have one you do not pay extra.
		</p>
	</section>

	<section class="research">
		<h2>Research directions</h2>
		<p class="research-intro">What are the research problems? Writing is different from coding&mdash;it is more personal, more taste-driven, and harder to evaluate mechanically. That means we need new harnesses, interfaces, evals, and good practices built specifically for writing with AI.</p>
		<div class="research-grid">
			<div class="research-card">
				<h3>Harness engineering</h3>
				<p>What does an AI writing harness need? Turns out there are many moving parts that are hard to design well: CRDT-backed documents and custom MCP tools for agent edits, skills that encode good writing practices and the human's voice, and hooks and subagents for rules and revision passes.</p>
			</div>
			<div class="research-card">
				<h3>Human steering of long-horizon tasks</h3>
				<p>Writing a paper or book takes many rounds of editing over months. It is not obvious how to let writers steer agents in real time over long horizons, keep quality consistent as documents grow, or enforce rules across hundreds of edits&hellip;let alone how to present changes without overwhelming the writer.</p>
			</div>
			<div class="research-card">
				<h3>Characterizing slopwords and good practices</h3>
				<p>Everyone complains about AI &ldquo;slop,&rdquo; but we lack good ways to characterize it and monitor it over time, especially as new models come out. While startups like <a href="https://www.pangram.com/" target="_blank" rel="noopener">Pangram Labs</a> sell useful slop detection products, we want to build open source frameworks that researchers and writers can use to identify slopwords and track how they change over time.</p>
			</div>
		</div>
	</section>

	<section class="start">
		<h2>Try it</h2>
		<div class="try-buttons">
			<div class="install-block disabled"><code>npx docwriter</code> <span class="install-note">(coming soon!)</span></div>
			<div class="install-block disabled"><code>plain-writing skill</code> <span class="install-note">(private repo)</span></div>
			<a href="https://github.com/shreyashankar/docwriter" class="install-block" target="_blank" rel="noopener"><code>github.com/shreyashankar/docwriter</code></a>
		</div>
	</section>

	<section class="involved">
		<h2>Want to get involved?</h2>
		<p>
			We are looking for user study participants. If you are willing to write and publish a blog post, paper, or other long-form document using DocWriter and share your experience with us, we would love to hear from you.
		</p>
		<p>
			Reach out at <a href="mailto:shreyashankar@berkeley.edu">shreyashankar@berkeley.edu</a>.
		</p>
	</section>

	<footer class="footer">
		<span class="footer-name">DocWriter</span>
		<span class="sep">&middot;</span>
		<span>EPIC Data Lab, UC Berkeley</span>
	</footer>
</div>

<style>
	:global(body) {
		margin: 0; background: #faf9f6;
		overflow-x: hidden; overflow-y: auto !important; height: auto !important;
	}
	.page {
		font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		color: #1a1a1a; opacity: 0; transition: opacity 300ms ease;
	}
	.page.mounted { opacity: 1; }

	.nav { display: flex; align-items: center; justify-content: space-between; max-width: 920px; margin: 0 auto; padding: 20px 24px; }
	.logo { font-family: 'Lora', Georgia, serif; font-size: 18px; font-weight: 600; }
	.nav-right { display: flex; gap: 20px; }
	.nav-link { font-size: 13px; font-weight: 500; color: #555; text-decoration: none; }
	.nav-link:hover { color: #1a1a1a; }

	.hero { max-width: 640px; margin: 52px auto 0; padding: 0 24px; text-align: center; }
	.hl { background: rgba(5,150,105,0.1); padding: 1px 4px; border-radius: 3px; }

	h1 { margin: 0 0 10px; font-family: 'Lora', Georgia, serif; font-size: 40px; font-weight: 700; letter-spacing: -0.02em; }
	.subtitle { margin: 0; font-size: 18px; line-height: 1.5; color: #333; font-style: italic; }
	.subtitle a { color: #003262; text-decoration: none; font-weight: 500; font-style: normal; }
	.subtitle a:hover { text-decoration: underline; }

	.demo-wrap { max-width: 940px; margin: 56px auto 0; padding: 0 24px; }
	.demo-window { border: 1px solid #d4d1ca; border-radius: 10px; overflow: hidden; background: #fff; box-shadow: 0 6px 32px rgba(0,0,0,0.06); }
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
	.outline-item.muted { color: #bbb; font-style: italic; }
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
	.t.inst { color: #6d28d9; background: rgba(109,40,217,0.06); border-radius: 3px; padding: 1px 4px; }
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

	.caption { text-align: center; margin: 14px 0 0; font-size: 13px; line-height: 1.55; color: #888; }

	/* About */
	.about { max-width: 640px; margin: 56px auto 0; padding: 0 24px; }
	.about h2 { font-family: 'Lora', Georgia, serif; font-size: 23px; font-weight: 600; margin: 0 0 12px; }
	.about p { margin: 0 0 14px; font-size: 15px; line-height: 1.7; color: #444; }
	.about p:last-child { margin-bottom: 0; }
	.about code { font-family: 'Geist Mono', 'SFMono-Regular', Consolas, monospace; font-size: 13px; background: rgba(109,40,217,0.06); padding: 1px 5px; border-radius: 3px; color: #6d28d9; }

	/* Research */
	.research { max-width: 640px; margin: 56px auto 0; padding: 0 24px; }
	.research h2 { font-family: 'Lora', Georgia, serif; font-size: 23px; font-weight: 600; margin: 0 0 8px; }
	.research-intro { margin: 0 0 20px; font-size: 15px; line-height: 1.7; color: #444; }
	.research-grid { display: grid; grid-template-columns: 1fr; gap: 14px; }
	.research-card { padding: 18px 20px; border: 1px solid #e8e5de; border-radius: 8px; background: #fff; }
	.research-card h3 { margin: 0 0 6px; font-family: 'Lora', Georgia, serif; font-size: 15px; font-weight: 600; }
	.research-card p { margin: 0; font-size: 14.5px; line-height: 1.65; color: #555; }
	.research-card a { color: #003262; text-decoration: none; font-weight: 500; }
	.research-card a:hover { text-decoration: underline; }

	.start { max-width: 640px; margin: 56px auto 0; padding: 0 24px; }
	.start h2 { font-family: 'Lora', Georgia, serif; font-size: 23px; font-weight: 600; margin: 0 0 18px; }
	.try-buttons { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; }
	.install-block {
		display: inline-block;
		padding: 12px 22px;
		background: #1a1a1a;
		border-radius: 8px;
		text-decoration: none;
		border: none;
	}
	.install-block.disabled { opacity: 0.45; cursor: not-allowed; }
	.install-block code { font-family: 'Geist Mono', 'SFMono-Regular', Consolas, monospace; font-size: 14px; color: #e0e0e0; }
	.install-note { font-size: 13px; color: #999; font-style: italic; margin-left: 6px; }

	.involved { max-width: 640px; margin: 56px auto 0; padding: 0 24px; }
	.involved h2 { font-family: 'Lora', Georgia, serif; font-size: 23px; font-weight: 600; margin: 0 0 10px; }
	.involved p { margin: 0 0 12px; font-size: 15px; line-height: 1.7; color: #444; }
	.involved p:last-child { margin-bottom: 0; }
	.involved a { color: #003262; text-decoration: none; font-weight: 500; }
	.involved a:hover { text-decoration: underline; }

	.footer { max-width: 920px; margin: 56px auto 0; padding: 22px 24px 32px; border-top: 1px solid #e8e5de; text-align: center; font-size: 13px; color: #888; }
	.footer-name { font-family: 'Lora', Georgia, serif; font-weight: 600; color: #555; }
	.sep { margin: 0 6px; }

	@media (max-width: 780px) {
		.demo-body { grid-template-columns: 1fr; }
		.demo-left { display: none; }
		.demo-right { display: none; }
	}
</style>
