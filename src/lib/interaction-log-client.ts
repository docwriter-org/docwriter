/**
 * Client-side interaction logger. Records view-layer interactions that
 * never otherwise reach the server (toggles, panel opens, hovers…) into
 * the server's append-only `interaction_events` table via `POST /api/log`.
 *
 * Transport: a bounded in-memory queue flushed every second (or at batch
 * size) with a keepalive fetch; on pagehide/hidden the remaining queue
 * goes out through `navigator.sendBeacon` so a closing tab can't lose the
 * tail. Fire-and-forget: never throws, never blocks the UI, drops oldest
 * events rather than growing unbounded if the server is unreachable.
 *
 * This module also owns window focus/visibility tracking (`app.focus`)
 * so the "went hidden" event is enqueued before the hidden-flush beacon
 * that ships it — component-level listeners couldn't guarantee that order.
 */
import { browser } from '$app/environment';
import {
	MAX_LOG_BATCH_EVENTS,
	type ClientLogBatch,
	type ClientLogEvent,
	type InteractionEventName
} from '$lib/shared/interaction-events';

const FLUSH_MS = 1_000;
const BACKOFF_MS = 5_000;
const MAX_QUEUE = 400;

/** Random per page load; distinguishes multiple open windows in the log. */
const windowId = Math.random().toString(36).slice(2, 10);

let queue: ClientLogEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushDelay = FLUSH_MS;
let currentTabId: string | null = null;

/** Ambient tab context: events emitted without an explicit tabId are
 * attributed to the tab the user is looking at. +page.svelte calls this
 * whenever the active tab changes. */
export function setLogTabContext(tabId: string | null) {
	currentTabId = tabId;
}

/** Queue one interaction event. Safe to call anywhere (no-op during SSR). */
export function logUi(
	event: InteractionEventName,
	data?: Record<string, unknown>,
	tabId?: string | null
) {
	if (!browser) return;
	queue.push({
		event,
		...(data && Object.keys(data).length > 0 ? { data } : {}),
		...(tabId ?? currentTabId ? { tabId: (tabId ?? currentTabId) as string } : {}),
		clientTs: Date.now()
	});
	if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
	if (queue.length >= MAX_LOG_BATCH_EVENTS) {
		void flush();
	} else if (!flushTimer) {
		flushTimer = setTimeout(() => void flush(), flushDelay);
	}
}

function takeBatch(): ClientLogBatch | null {
	if (queue.length === 0) return null;
	const events = queue.slice(0, MAX_LOG_BATCH_EVENTS);
	queue = queue.slice(events.length);
	return { windowId, events };
}

async function flush() {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	const batch = takeBatch();
	if (!batch) return;
	try {
		const res = await fetch('/api/log', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(batch),
			keepalive: true
		});
		if (!res.ok) throw new Error(String(res.status));
		flushDelay = FLUSH_MS;
	} catch {
		// Requeue at the front and back off; the bounded queue caps memory.
		queue = [...batch.events, ...queue].slice(-MAX_QUEUE);
		flushDelay = BACKOFF_MS;
	}
	if (queue.length > 0 && !flushTimer) {
		flushTimer = setTimeout(() => void flush(), flushDelay);
	}
}

/** Synchronous best-effort flush for pagehide/hidden — sendBeacon survives
 * the page being torn down where fetch may not. */
function flushBeacon() {
	if (typeof navigator === 'undefined' || !navigator.sendBeacon) return;
	let batch: ClientLogBatch | null;
	while ((batch = takeBatch())) {
		const blob = new Blob([JSON.stringify(batch)], { type: 'application/json' });
		if (!navigator.sendBeacon('/api/log', blob)) {
			// Beacon refused (quota) — put the batch back and stop trying.
			queue = [...batch.events, ...queue].slice(-MAX_QUEUE);
			break;
		}
	}
}

// ---------------------------------------------------------------------------
// Focus / visibility tracking (`app.focus`)
// ---------------------------------------------------------------------------
if (browser) {
	let last = { focused: document.hasFocus(), visible: !document.hidden };
	// Page-load marker: initial focus state, tagged with this window's ID.
	logUi('app.focus', { ...last, initial: true });

	// Snapshot the client-only view prefs once per page load. These live in
	// localStorage and never reach the server on their own, so without this
	// event an analysis only sees TRANSITIONS (ui.provenance, ui.dock, …)
	// and cannot know the state a session STARTED in. Values are passed raw
	// (string | null); null = key unset = the app default.
	const ls = (k: string) => window.localStorage.getItem(k);
	logUi('app.client_state', {
		provenance: ls('docwriter.showAiProvenance'),
		dockExpanded: ls('docwriter.dockExpanded'),
		model: ls('docwriter.selectedModel'),
		provider: ls('docwriter.selectedProvider'),
		historyVerbosity: ls('docwriter.historyVerbosity'),
		filesPane: ls('docwriter.showFilesPane'),
		sidebar: ls('docwriter.showSidebar')
	});

	const track = () => {
		const now = { focused: document.hasFocus(), visible: !document.hidden };
		// blur + visibilitychange often double-fire; only log state changes.
		if (now.focused !== last.focused || now.visible !== last.visible) {
			last = now;
			logUi('app.focus', now);
		}
		if (!now.visible) flushBeacon();
	};
	window.addEventListener('focus', track);
	window.addEventListener('blur', track);
	document.addEventListener('visibilitychange', track);
	window.addEventListener('pagehide', flushBeacon);
}
