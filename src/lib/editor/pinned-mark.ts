import { Mark } from '@tiptap/core';

// Single pinned mark — used for all pinned text (from atoms or prose)
export const Pinned = Mark.create({
	name: 'pinned',
	addAttributes() {
		return {
			word: { default: null }
		};
	},
	parseHTML() {
		return [
			{ tag: 'span[data-pinned]' },
			{ tag: 'span[data-atom-pinned]' },
			{ tag: 'span[data-editor-pinned]' }
		];
	},
	renderHTML({ HTMLAttributes }) {
		return ['span', {
			...HTMLAttributes,
			'data-pinned': '',
			class: 'pinned-mark',
			contenteditable: 'false'
		}, 0];
	}
});

// Keep legacy exports so existing code doesn't break during migration
export const AtomPinned = Pinned;
export const EditorPinned = Pinned;

// User-edit mark — shows text the user changed directly (suggesting mode)
export const UserEdit = Mark.create({
	name: 'userEdit',
	addAttributes() {
		return {
			timestamp: { default: null }
		};
	},
	parseHTML() {
		return [{ tag: 'span[data-user-edit]' }];
	},
	renderHTML({ HTMLAttributes }) {
		return ['span', {
			...HTMLAttributes,
			'data-user-edit': '',
			style: 'background: color-mix(in srgb, var(--accent) 10%, transparent); border-radius: 2px;'
		}, 0];
	}
});
