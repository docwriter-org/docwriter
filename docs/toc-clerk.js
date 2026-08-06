/**
 * Compass / Fumadocs-clerk style TOC: hierarchical SVG connectors plus a
 * primary-colored path whose clip-path slides with the active heading(s).
 *
 * Mintlify already marks `.toc-item[data-active]` / `[data-active-deepest]`.
 * This script only adds the visual track + thumb animation.
 */
(() => {
	const TOC_SELECTOR = '#table-of-contents-content.toc';
	const BASE = 8;

	/** @type {WeakMap<Element, { disconnect: () => void }>} */
	const enhanced = new WeakMap();

	function getLineOffset(depth) {
		if (depth <= 0) return BASE;
		if (depth === 1) return 12 + BASE;
		return 24 + BASE;
	}

	function getItemPad(depth) {
		if (depth <= 0) return 12 + BASE;
		if (depth === 1) return 24 + BASE;
		return 36 + BASE;
	}

	function readDepth(item) {
		const raw = item.getAttribute('data-depth');
		const n = raw == null ? 0 : Number(raw);
		return Number.isFinite(n) ? n : 0;
	}

	function clearBranches(list) {
		list.querySelectorAll('.dw-toc-branch, .dw-toc-thumb').forEach((el) => el.remove());
	}

	/**
	 * Anchor offsetTop is relative to the nearest positioned ancestor. Mintlify
	 * marks each `.toc-item` as `relative`, so we measure against the list box.
	 * @param {HTMLElement} list
	 * @param {HTMLElement} anchor
	 */
	function measureAnchor(list, anchor) {
		const listRect = list.getBoundingClientRect();
		const rect = anchor.getBoundingClientRect();
		const styles = getComputedStyle(anchor);
		const padTop = parseFloat(styles.paddingTop) || 0;
		const padBottom = parseFloat(styles.paddingBottom) || 0;
		const top = rect.top - listRect.top + list.scrollTop + padTop;
		const bottom = rect.bottom - listRect.top + list.scrollTop - padBottom;
		return { top, bottom };
	}

	/**
	 * @param {HTMLElement} list
	 */
	function build(list) {
		// Mintlify nests h3+ items under their parent <li>, so collect every
		// .toc-item in document order rather than only direct children.
		const items = Array.from(list.querySelectorAll('.toc-item'));
		if (items.length === 0) return null;

		clearBranches(list);
		list.classList.add('dw-toc-clerk');

		/** @type {{ item: HTMLElement, anchor: HTMLElement, depth: number, top: number, bottom: number, x: number }[]} */
		const entries = [];

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const anchor = item.querySelector(':scope > a');
			if (!(anchor instanceof HTMLElement)) continue;

			const depth = readDepth(item);
			const pad = getItemPad(depth);
			anchor.style.setProperty('--dw-toc-item-pad', `${pad}px`);
			// Nested Mintlify items also set --toc-padding-left; keep both in sync
			// so utility padding and our override agree.
			anchor.style.setProperty('--toc-padding-left', `${Math.max(0, pad - BASE)}px`);

			const l1 = getLineOffset(depth);
			const prevDepth = i === 0 ? depth : readDepth(items[i - 1]);
			const nextDepth = i === items.length - 1 ? depth : readDepth(items[i + 1]);
			const l0 = i === 0 ? l1 : getLineOffset(prevDepth);
			const l2 = i === items.length - 1 ? l1 : getLineOffset(nextDepth);
			const width = Math.max(l0, l1) + 9;

			const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			svg.setAttribute('aria-hidden', 'true');
			svg.classList.add('dw-toc-branch');
			svg.style.width = `${width}px`;
			if (l1 !== l2) {
				svg.style.height = '100%';
				svg.style.bottom = '0.375rem';
			}

			if (l0 !== l1) {
				const bend = document.createElementNS('http://www.w3.org/2000/svg', 'path');
				bend.setAttribute(
					'd',
					`M ${l0 + 0.5} 0 C ${l0 + 0.5} 8 ${l1 + 0.5} 4 ${l1 + 0.5} 12`,
				);
				svg.appendChild(bend);
			}

			const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			line.setAttribute('x1', String(l1 + 0.5));
			line.setAttribute('y1', l0 === l1 ? '6' : '12');
			line.setAttribute('x2', String(l1 + 0.5));
			line.setAttribute('y2', '100%');
			svg.appendChild(line);

			anchor.prepend(svg);
			entries.push({ item, anchor, depth, top: 0, bottom: 0, x: l1 + 0.5 });
		}

		if (entries.length === 0) return null;

		let pathD = '';
		let maxW = 0;
		let maxH = 0;
		/** @type {[number, number, number][]} */
		const positions = [];

		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			const { top, bottom } = measureAnchor(list, entry.anchor);
			const x = entry.x;

			entry.top = top;
			entry.bottom = bottom;
			positions.push([top, bottom, x]);
			maxW = Math.max(maxW, x + 8);
			maxH = Math.max(maxH, bottom);

			if (i === 0) {
				pathD += `M${x} ${top} L${x} ${bottom}`;
			} else {
				const [, upperBottom, upperX] = positions[i - 1];
				pathD += ` L${upperX} ${upperBottom} ${x} ${top} L${x} ${bottom}`;
			}
		}

		const thumb = document.createElement('div');
		thumb.className = 'dw-toc-thumb';
		thumb.setAttribute('aria-hidden', 'true');
		thumb.style.width = `${maxW}px`;
		thumb.style.height = `${maxH}px`;

		const thumbSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		thumbSvg.setAttribute('viewBox', `0 0 ${maxW} ${maxH}`);
		thumbSvg.setAttribute('width', String(maxW));
		thumbSvg.setAttribute('height', String(maxH));

		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', pathD);
		path.setAttribute('fill', 'none');
		path.setAttribute('stroke-width', '1.5');
		path.setAttribute('stroke-linecap', 'round');
		path.setAttribute('stroke-linejoin', 'round');
		// Presentation attribute so stroke stays visible even if theme tokens
		// are space-separated RGB components that invalidate CSS `stroke: var(--primary)`.
		path.setAttribute('stroke', 'currentColor');
		thumbSvg.appendChild(path);
		thumb.appendChild(thumbSvg);
		list.prepend(thumb);

		function applyThumb() {
			const activeIdx = [];
			for (let i = 0; i < entries.length; i++) {
				if (entries[i].item.hasAttribute('data-active')) activeIdx.push(i);
			}
			if (activeIdx.length === 0) {
				for (let i = 0; i < entries.length; i++) {
					if (entries[i].item.hasAttribute('data-active-deepest')) {
						activeIdx.push(i);
					}
				}
			}
			if (activeIdx.length === 0) {
				thumb.style.setProperty('--dw-track-top', '0px');
				thumb.style.setProperty('--dw-track-bottom', '0px');
				return;
			}
			const start = activeIdx[0];
			const end = activeIdx[activeIdx.length - 1];
			thumb.style.setProperty('--dw-track-top', `${positions[start][0]}px`);
			thumb.style.setProperty('--dw-track-bottom', `${positions[end][1]}px`);
		}

		applyThumb();

		const attrObserver = new MutationObserver((mutations) => {
			for (const m of mutations) {
				if (
					m.type === 'attributes' &&
					(m.attributeName === 'data-active' ||
						m.attributeName === 'data-active-deepest')
				) {
					applyThumb();
					return;
				}
			}
		});
		for (const entry of entries) {
			attrObserver.observe(entry.item, {
				attributes: true,
				attributeFilter: ['data-active', 'data-active-deepest'],
			});
		}

		return {
			disconnect() {
				attrObserver.disconnect();
				clearBranches(list);
				list.classList.remove('dw-toc-clerk');
				for (const entry of entries) {
					entry.anchor.style.removeProperty('--dw-toc-item-pad');
				}
			},
		};
	}

	function enhance(list) {
		const prev = enhanced.get(list);
		if (prev) prev.disconnect();
		const handle = build(list);
		if (handle) enhanced.set(list, handle);
	}

	function scan() {
		document.querySelectorAll(TOC_SELECTOR).forEach((list) => {
			if (!(list instanceof HTMLElement)) return;
			enhance(list);
		});
	}

	let scanScheduled = false;
	function scheduleScan() {
		if (scanScheduled) return;
		scanScheduled = true;
		requestAnimationFrame(() => {
			scanScheduled = false;
			scan();
		});
	}

	function boot() {
		scan();

		const rootObserver = new MutationObserver((mutations) => {
			for (const m of mutations) {
				if (m.type !== 'childList') continue;
				for (const node of m.addedNodes) {
					if (!(node instanceof Element)) continue;
					if (
						node.matches?.(TOC_SELECTOR) ||
						node.querySelector?.(TOC_SELECTOR) ||
						node.classList?.contains('toc-item')
					) {
						scheduleScan();
						return;
					}
				}
			}
		});
		rootObserver.observe(document.documentElement, {
			childList: true,
			subtree: true,
		});

		window.addEventListener('resize', scheduleScan, { passive: true });
		window.addEventListener('load', scheduleScan);

		const pushState = history.pushState;
		history.pushState = function (...args) {
			const result = pushState.apply(this, args);
			scheduleScan();
			setTimeout(scheduleScan, 50);
			setTimeout(scheduleScan, 250);
			return result;
		};
		window.addEventListener('popstate', () => {
			scheduleScan();
			setTimeout(scheduleScan, 50);
			setTimeout(scheduleScan, 250);
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot, { once: true });
	} else {
		boot();
	}
})();
