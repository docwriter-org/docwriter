/**
 * Lightweight hover tooltip action.
 *
 * Usage:
 *   <button use:tooltip={'Detailed explanation'}>label</button>
 *
 * Fires faster than the browser's native `title` attribute (which sits at
 * ~500-700ms before showing). Tooltip text supports multi-line strings and
 * positions itself above the target, flipping below when there isn't room.
 */
const SHOW_DELAY_MS = 220;
const HIDE_DELAY_MS = 60;

let activeTip: HTMLDivElement | null = null;

function getTipElement(): HTMLDivElement {
	if (activeTip) return activeTip;
	const el = document.createElement('div');
	el.setAttribute('role', 'tooltip');
	el.className = 'dw-tooltip';
	document.body.appendChild(el);
	activeTip = el;
	return el;
}

function positionTip(target: Element, tip: HTMLDivElement) {
	const targetRect = target.getBoundingClientRect();
	const tipRect = tip.getBoundingClientRect();
	const margin = 8;
	const vw = window.innerWidth;
	const vh = window.innerHeight;

	// Prefer placing above the target; flip below if not enough room.
	let top = targetRect.top - tipRect.height - margin;
	let flippedBelow = false;
	if (top < margin) {
		top = targetRect.bottom + margin;
		flippedBelow = true;
	}

	// Center horizontally on the target, clamped to the viewport.
	let left = targetRect.left + targetRect.width / 2 - tipRect.width / 2;
	left = Math.max(margin, Math.min(vw - tipRect.width - margin, left));

	tip.style.top = `${Math.max(margin, Math.min(vh - tipRect.height - margin, top))}px`;
	tip.style.left = `${left}px`;
	tip.dataset.flipped = flippedBelow ? 'true' : 'false';
}

export function tooltip(node: HTMLElement, text: string) {
	let showTimer: ReturnType<typeof setTimeout> | null = null;
	let hideTimer: ReturnType<typeof setTimeout> | null = null;
	let currentText = text;

	function clearTimers() {
		if (showTimer) { clearTimeout(showTimer); showTimer = null; }
		if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
	}

	function show() {
		if (!currentText) return;
		const tip = getTipElement();
		tip.textContent = currentText;
		tip.classList.add('visible');
		// Two-frame defer so the browser has measured the tooltip before
		// we position it; otherwise width/height read as 0 and the
		// placement is off-screen until the next mouse-move.
		requestAnimationFrame(() => requestAnimationFrame(() => positionTip(node, tip)));
	}

	function hide() {
		if (activeTip) activeTip.classList.remove('visible');
	}

	function onEnter() {
		clearTimers();
		showTimer = setTimeout(show, SHOW_DELAY_MS);
	}

	function onLeave() {
		clearTimers();
		hideTimer = setTimeout(hide, HIDE_DELAY_MS);
	}

	node.addEventListener('mouseenter', onEnter);
	node.addEventListener('mouseleave', onLeave);
	node.addEventListener('focus', onEnter);
	node.addEventListener('blur', onLeave);

	return {
		update(next: string) {
			currentText = next;
		},
		destroy() {
			clearTimers();
			node.removeEventListener('mouseenter', onEnter);
			node.removeEventListener('mouseleave', onLeave);
			node.removeEventListener('focus', onEnter);
			node.removeEventListener('blur', onLeave);
			hide();
		}
	};
}
