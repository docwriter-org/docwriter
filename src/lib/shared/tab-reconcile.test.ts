import { describe, expect, it } from 'vitest';
import { classifyGhostTabs, resolveTabRename, visibleTabsState } from './tab-reconcile';

describe('visibleTabsState', () => {
	it('hides missing files without requiring a persisted drop', () => {
		const visible = visibleTabsState(
			{ order: ['research_2026.tex', 'teaching_2026.tex'], active: 'research_2026.tex' },
			(id) => id === 'teaching_2026.tex'
		);
		expect(visible).toEqual({
			order: ['teaching_2026.tex'],
			active: 'teaching_2026.tex'
		});
	});
});

describe('classifyGhostTabs', () => {
	it('flags a heavily-edited tab that left the tabs table while the file remains', () => {
		const ghosts = classifyGhostTabs({
			openTabIds: ['teaching_2026.tex', 'aditya_statement_2026.tex'],
			yjsTabIds: ['research_2026.tex', 'teaching_2026.tex', 'cv.pdf'],
			lastSeenTabIds: ['research_2026.tex', 'cv.pdf'],
			fileExists: (id) => id !== 'cv.pdf'
		});
		expect(ghosts).toEqual([
			{
				tabId: 'cv.pdf',
				kind: 'missing',
				hasUpdates: true,
				hasLastSeen: true
			},
			{
				tabId: 'research_2026.tex',
				kind: 'closed',
				hasUpdates: true,
				hasLastSeen: true
			}
		]);
	});
});

describe('resolveTabRename', () => {
	it('treats a file-tree move as already done when only the new path exists', () => {
		expect(resolveTabRename(false, true)).toBe('already-moved');
		expect(resolveTabRename(true, false)).toBe('rename');
		expect(resolveTabRename(false, false)).toBe('source-missing');
		expect(resolveTabRename(true, true)).toBe('target-exists');
	});
});
