/**
 * Guard: no agent-facing prompt may tell the agent to hand document work to
 * a subagent.
 *
 * `docwriter-doc` is an in-process SDK MCP server bound to the query that
 * connects it. A subagent cannot reach it — its read_doc / comment_doc /
 * edit_doc calls fail with "Stream closed", and the failure takes the
 * parent's connection with it. Critique passes shipped this way and
 * silently produced nothing: the reviewer did the whole analysis and could
 * not land a single finding. Feedback import and the main system prompt
 * carried the same instruction.
 *
 * This is a prompt-level contract, so a prompt-level test is what guards
 * it. If the SDK ever makes in-process MCP servers reachable from
 * subagents, delete this file deliberately rather than letting a prompt
 * edit quietly reintroduce the failure.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../../..');

/** Files whose text reaches the agent as a prompt or injected turn. */
const AGENT_FACING = [
	'src/lib/server/reviewers.ts',
	'src/lib/shared/feedback-import.ts',
	'src/routes/api/render/+server.ts'
];

/** Phrases that would send document work to a subagent. */
const DELEGATION = [
	/spawn (?:exactly )?(?:one|a|N|\d+) subagents?/i,
	/spawn subagents/i,
	/fan out/i,
	/split (?:comments|feedback|the \w+) across subagents/i,
	/use one subagent per/i
];

describe('no prompt delegates document work to a subagent', () => {
	for (const rel of AGENT_FACING) {
		it(`${rel} carries no delegation instruction`, () => {
			const text = readFileSync(join(ROOT, rel), 'utf8');
			// Comments explaining WHY not to delegate are fine; instructions
			// are not. Strip nothing — the phrases above only appear as
			// instructions, and the explanatory comments use "delegate".
			const hits = DELEGATION.filter((re) => re.test(text)).map((re) => re.source);
			expect(hits, `${rel} tells the agent to delegate: ${hits.join(', ')}`).toEqual([]);
		});
	}

	it('the critique brief and the system prompt say why delegation is off', () => {
		const critique = readFileSync(join(ROOT, 'src/lib/server/reviewers.ts'), 'utf8');
		expect(critique).toMatch(/Do not delegate/i);
		expect(critique).toMatch(/in this turn/i);

		const prompt = readFileSync(join(ROOT, 'src/routes/api/render/+server.ts'), 'utf8');
		expect(prompt).toMatch(/Never hand document work to a subagent/i);
	});
});
