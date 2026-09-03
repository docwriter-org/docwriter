/**
 * Guard: the agent explains on a thread and proposes the edit in the same
 * turn. There is no "Approve & propose edit" step in between.
 *
 * The removed flow had the agent attach a sketched `proposed_edit` to a
 * comment, the gutter render an approve button, and the approval trigger a
 * second render whose edit_doc finally landed the pending diff. Two
 * approvals for one change, and the agent's tool result in the middle told
 * the author the edit was already in. The contract now: a reply that names
 * a change is followed by edit_doc on the same thread; only genuine
 * uncertainty about the change itself earns a reply with no proposal.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

describe('a reply that names a change comes with the edit, not an approve button', () => {
	it('no agent tool accepts a sketched edit for later approval', () => {
		for (const rel of [
			'src/lib/server/mcp-doc-tools.ts',
			'src/lib/server/providers/tool-handlers.ts'
		]) {
			const src = read(rel);
			expect(src, rel).not.toMatch(/proposed_edit/);
			expect(src, rel).not.toMatch(/Approve & propose/);
		}
	});

	it('the gutter has no approve button and the editor no approval trigger', () => {
		expect(read('src/lib/components/CommentGutter.svelte')).not.toMatch(/approve-btn|onApprove/);
		expect(read('src/lib/editor/TiptapEditor.svelte')).not.toMatch(/onApprove|I approved/);
	});

	it('the routing rule tells the agent to propose the edit in the same turn as its reply', () => {
		const prompt = read('src/routes/api/render/+server.ts').replace(/\s+/g, ' ');
		expect(prompt).toMatch(/call edit_doc with the thread_id in the same turn/);
		expect(prompt).toMatch(/There is no approval step between a reply and its edit/);
		expect(prompt).toMatch(/genuine uncertainty about how to make the change/);
		expect(prompt).not.toMatch(/proposed_edit/);
	});

	it('legacy sketched edits are not read back to the agent', () => {
		expect(read('src/lib/shared/list-threads.ts')).not.toMatch(/proposedEdit/);
	});
});
