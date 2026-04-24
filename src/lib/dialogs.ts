/**
 * In-app replacement for `window.alert` / `window.confirm`.
 *
 * The Dialog.svelte component subscribes to `dialogQueue` and renders the
 * first pending dialog; `showAlert` / `showConfirm` push onto the queue and
 * return a Promise that resolves when the user dismisses it.
 */
import { writable } from 'svelte/store';

export interface DialogSpec {
	id: string;
	title?: string;
	message: string;
	/** When set, a Cancel button is shown; otherwise the dialog is
	 * alert-style (single confirm button). */
	cancelLabel?: string;
	confirmLabel?: string;
	/** Render the confirm button in a destructive red. */
	danger?: boolean;
	resolve: (ok: boolean) => void;
}

export const dialogQueue = writable<DialogSpec[]>([]);

function pushDialog(spec: Omit<DialogSpec, 'id' | 'resolve'>): Promise<boolean> {
	return new Promise((resolve) => {
		const id = 'dlg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
		dialogQueue.update((q) => [...q, { ...spec, id, resolve }]);
	});
}

export function resolveDialog(id: string, ok: boolean) {
	dialogQueue.update((q) => {
		const next = q.slice();
		const idx = next.findIndex((d) => d.id === id);
		if (idx >= 0) {
			const [removed] = next.splice(idx, 1);
			removed.resolve(ok);
		}
		return next;
	});
}

export function showAlert(message: string, opts?: { title?: string; confirmLabel?: string }): Promise<void> {
	return pushDialog({
		message,
		title: opts?.title,
		confirmLabel: opts?.confirmLabel ?? 'OK'
	}).then(() => undefined);
}

export function showConfirm(
	message: string,
	opts?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
): Promise<boolean> {
	return pushDialog({
		message,
		title: opts?.title,
		confirmLabel: opts?.confirmLabel ?? 'Confirm',
		cancelLabel: opts?.cancelLabel ?? 'Cancel',
		danger: opts?.danger
	});
}
