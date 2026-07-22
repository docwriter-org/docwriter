/**
 * Server-side reviewer storage + the critique-pass brief.
 *
 * Custom reviewers persist in the SQLite `reviewers` table; built-ins come
 * from src/lib/shared/reviewers.ts. `buildCritiqueMessage` composes the
 * per-render instruction that tells the main agent to spawn the reviewer
 * subagent with its brief.
 */
import { getDb } from './db';
import { BUILTIN_REVIEWERS, findReviewer, type Reviewer } from '$lib/shared/reviewers';

interface ReviewerRow {
	id: string;
	name: string;
	icon: string;
	color: string;
	prompt: string;
}

function rowToReviewer(row: ReviewerRow): Reviewer {
	return {
		id: row.id,
		name: row.name,
		icon: row.icon,
		color: row.color,
		prompt: row.prompt
	};
}

export function listCustomReviewers(): Reviewer[] {
	const rows = getDb()
		.prepare('SELECT id, name, icon, color, prompt FROM reviewers ORDER BY created_at')
		.all() as ReviewerRow[];
	return rows.map(rowToReviewer);
}

/** Built-ins first, then custom reviewers in creation order. */
export function listReviewers(): Reviewer[] {
	return [...BUILTIN_REVIEWERS, ...listCustomReviewers()];
}

export function getReviewerById(id: string): Reviewer | null {
	return findReviewer(id, listCustomReviewers());
}

export function createReviewer(input: {
	name: string;
	icon: string;
	color: string;
	prompt: string;
}): Reviewer {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	const id =
		'rev-' +
		(c?.randomUUID
			? c.randomUUID()
			: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
	getDb()
		.prepare(
			'INSERT INTO reviewers (id, name, icon, color, prompt, created_at) VALUES (?, ?, ?, ?, ?, ?)'
		)
		.run(id, input.name, input.icon, input.color, input.prompt, Date.now());
	return { id, name: input.name, icon: input.icon, color: input.color, prompt: input.prompt };
}

/** Delete a custom reviewer. Built-ins are not in the table, so deleting
 * one is a no-op that returns false. */
export function deleteReviewer(id: string): boolean {
	const result = getDb().prepare('DELETE FROM reviewers WHERE id = ?').run(id);
	return result.changes > 0;
}

/** The message a critique render sends to the main agent: spawn one
 * subagent carrying the reviewer's brief. The brief is the reviewer's own
 * prompt plus the shared pass procedure; the subagent inherits the system
 * prompt, so the house voice rules and the user's rules apply to it too. */
export function buildCritiqueMessage(reviewer: Reviewer, tabId: string): string {
	return [
		'<mode>',
		`Critique pass. The user asked the reviewer "${reviewer.name}" to review ${tabId}.`,
		'Spawn exactly one subagent with the Agent tool and pass it the reviewer_brief below verbatim as its task, nothing else. Do not read, comment, or edit the document yourself this turn. Leave assistant text empty; the review lands on the document. If the Agent tool is unavailable, execute the brief yourself exactly as written.',
		'</mode>',
		'',
		'<reviewer_brief>',
		`You are ${reviewer.name}, a reviewer running one critique pass on ${tabId}.`,
		'',
		reviewer.prompt,
		'',
		'Procedure:',
		`1. Call read_doc("${tabId}") and read the whole piece before judging any of it.`,
		'2. Work finding by finding, most important first. Stop at 6 findings; a pass that flags everything ranks nothing.',
		'3. Rationale first: for each finding call comment_doc anchored to the exact passage, with one to three first-person sentences on what is wrong and why it matters. If a local edit fixes it, then call edit_doc with that thread_id and the minimal fix. If only the author can resolve it, leave the comment without an edit.',
		'4. The rules in your instructions are binding. Do not rewrite the author\'s voice. Work in the document\'s own language; never translate.',
		'5. If the draft passes your lens, leave one comment on the opening line saying what works, and stop. Do not invent findings.',
		'</reviewer_brief>'
	].join('\n');
}
