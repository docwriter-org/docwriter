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
	// Both voices: persisted rounds/history may carry the old third-person
	// trigger ("The user clicked Accept…"); new triggers speak as the author.
	return /^(?:The user|I) clicked Accept on your previous edit/.test(trigger ?? '');
}
