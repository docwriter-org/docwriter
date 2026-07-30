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
