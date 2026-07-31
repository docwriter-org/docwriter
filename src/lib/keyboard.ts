/**
 * Platform-aware keyboard-shortcut labels for UI hints.
 *
 * Every send/submit shortcut in the app accepts both modifiers
 * (`e.key === 'Enter' && (e.metaKey || e.ctrlKey)`), but the label users
 * see should match their platform — "⌘↵" means nothing on Windows/Linux.
 * SSR has no `navigator`; the server renders the Ctrl fallback and the
 * browser corrects it during hydration.
 */
const isApplePlatform =
	typeof navigator !== 'undefined' &&
	/Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);

/** "⌘↵" on Apple platforms, "Ctrl+↵" elsewhere. */
export const modEnterLabel = isApplePlatform ? '⌘↵' : 'Ctrl+↵';

/** The standard send-surface hint ("⌘↵ to send"), composed once so every
 * Send button shows identical wording. Style it with the shared
 * `.kbd-hint` class (+layout.svelte). */
export const modEnterToSend = `${modEnterLabel} to send`;

/** True when a keyboard event is the send/submit shortcut the labels
 * above advertise. Both modifiers are accepted on every platform (only
 * the label is platform-specific) so muscle memory works across OSes.
 * Keep every submit-on-Enter handler on this predicate — a hand-rolled
 * variant that drifts would contradict the rendered hint. */
export function isModEnter(e: KeyboardEvent): boolean {
	return e.key === 'Enter' && (e.metaKey || e.ctrlKey);
}
