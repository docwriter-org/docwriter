/** Intent left when the user Accepts a stale/orphaned proposal: the agent
 * finds the current `old_string` and leaves a reviewable pending diff. */

export type StaleAcceptApply = {
	tabId: string;
	staleRoundId?: string;
	threadId?: string;
	newString?: string;
};

/** A stale-accept render is dedicated to rebasing that one change onto
 * the current text. Matching only on `new_string` would miss an adapted
 * replacement. */
export function matchesStaleAcceptApply(
	ctx: StaleAcceptApply | null | undefined,
	tabId: string
): boolean {
	return !!ctx && ctx.tabId === tabId;
}

export function isStaleAcceptFollowup(trigger: string | undefined): boolean {
	return /^The user clicked Accept on your previous edit/.test(trigger ?? '');
}
