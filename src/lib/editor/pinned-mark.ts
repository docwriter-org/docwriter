import { Mark } from '@tiptap/core';

// Atom-pinned words — indigo, non-editable
export const AtomPinned = Mark.create({
	name: 'atomPinned',
	addAttributes() {
		return {
			word: { default: null }
		};
	},
	parseHTML() {
		return [{ tag: 'span[data-atom-pinned]' }];
	},
	renderHTML({ HTMLAttributes }) {
		return ['span', {
			...HTMLAttributes,
			'data-atom-pinned': '',
			style: 'border-bottom: 2px solid var(--accent); font-weight: 600; cursor: default;',
			contenteditable: 'false'
		}, 0];
	}
});

// Editor-pinned words — amber, non-editable (user typed "Dear X" etc.)
export const EditorPinned = Mark.create({
	name: 'editorPinned',
	addAttributes() {
		return {};
	},
	parseHTML() {
		return [{ tag: 'span[data-editor-pinned]' }];
	},
	renderHTML({ HTMLAttributes }) {
		return ['span', {
			...HTMLAttributes,
			'data-editor-pinned': '',
			style: 'border-bottom: 2px solid #f59e0b; font-weight: 500; cursor: default;',
			contenteditable: 'false'
		}, 0];
	}
});

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
