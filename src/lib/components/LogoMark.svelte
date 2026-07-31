<script lang="ts">
	let {
		size = 42,
		interactive = true,
		title = ''
	}: { size?: number; interactive?: boolean; title?: string } = $props();
</script>

<svg
	class="dw-logo"
	class:interactive
	width={size}
	height={size}
	viewBox="0 0 560 560"
	fill="none"
	role={title ? 'img' : undefined}
	aria-label={title || undefined}
	aria-hidden={title ? undefined : 'true'}
	xmlns="http://www.w3.org/2000/svg"
>
	<g class="dw-mark">
		<g class="dw-d">
			<path
				class="dw-frame"
				fill-rule="evenodd"
				clip-rule="evenodd"
				d="M135.625 65.625C123.594 65.625 113.75 75.4688 113.75 87.5V472.5C113.75 484.531 123.594 494.375 135.625 494.375H290.938C422.188 494.375 505.312 405.781 505.312 280C505.312 154.219 422.188 65.625 290.938 65.625H135.625Z"
			/>
			<path
				class="dw-bowl"
				fill-rule="evenodd"
				clip-rule="evenodd"
				d="M262.5 165.156C264.141 160.781 267.969 158.594 272.344 158.594H293.125C297.5 158.594 301.328 160.781 302.969 165.156L360.938 319.375C367.5 336.875 364.219 353.281 351.094 366.406C333.594 382.812 318.281 409.062 312.812 439.688C309.531 458.281 308.438 475.781 308.438 494.375H251.562C251.562 475.781 250.469 458.281 247.188 439.688C241.719 409.062 226.406 382.812 208.906 366.406C195.781 353.281 192.5 336.875 199.062 319.375L262.5 165.156Z"
			/>
		</g>
		<path class="dw-nib" d="M270.156 319.375H289.844V494.375H270.156V319.375Z" />
		<circle class="dw-breather" cx="280" cy="299.688" r="28.438" />
	</g>
</svg>

<style>
	.dw-logo {
		display: block;
		flex-shrink: 0;
		overflow: visible;
		--dw-ink: #7c3aed;
		--dw-knockout: #faf9f6;
	}

	.dw-frame,
	.dw-nib,
	.dw-breather {
		fill: var(--dw-ink);
	}

	.dw-bowl {
		fill: var(--dw-knockout);
	}

	.dw-mark {
		transform-box: fill-box;
		transform-origin: center;
		transition: transform 180ms ease;
	}

	.dw-nib {
		opacity: 1;
		transform-box: fill-box;
		transform-origin: center bottom;
	}

	.dw-breather {
		opacity: 1;
		transform-box: fill-box;
		transform-origin: center;
	}

	.dw-logo.interactive {
		cursor: pointer;
	}

	.dw-logo.interactive:hover .dw-mark,
	:global(.logo:hover) .dw-logo.interactive .dw-mark,
	:global(.logo:focus-visible) .dw-logo.interactive .dw-mark {
		transform: scale(1.035);
	}

	.dw-logo.interactive:hover .dw-nib,
	:global(.logo:hover) .dw-logo.interactive .dw-nib,
	:global(.logo:focus-visible) .dw-logo.interactive .dw-nib {
		animation: dw-nib-enter 980ms cubic-bezier(0.18, 0.82, 0.24, 1.08) both;
	}

	.dw-logo.interactive:hover .dw-breather,
	:global(.logo:hover) .dw-logo.interactive .dw-breather,
	:global(.logo:focus-visible) .dw-logo.interactive .dw-breather {
		animation: dw-breather-pop 980ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
	}

	@keyframes dw-nib-enter {
		0% {
			opacity: 0;
			transform: translateY(-118px) scaleY(0.76);
		}
		50% {
			opacity: 1;
			transform: translateY(18px) scaleY(1.06);
		}
		74% {
			opacity: 1;
			transform: translateY(-6px) scaleY(0.98);
		}
		100% {
			opacity: 1;
			transform: translateY(0) scaleY(1);
		}
	}

	@keyframes dw-breather-pop {
		0%,
		58% {
			opacity: 0;
			transform: scale(0);
		}
		82% {
			opacity: 1;
			transform: scale(1.28);
		}
		100% {
			opacity: 1;
			transform: scale(1);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.dw-logo.interactive .dw-mark,
		.dw-logo.interactive:hover .dw-nib,
		.dw-logo.interactive:hover .dw-breather,
		:global(.logo:hover) .dw-logo.interactive .dw-nib,
		:global(.logo:hover) .dw-logo.interactive .dw-breather {
			animation: none;
			transition: none;
		}
	}
</style>
