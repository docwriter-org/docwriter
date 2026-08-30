/** Intent left when the user Accepts a stale/orphaned proposal: the agent
 * must find the current `old_string`, and that write should land immediately
 * instead of becoming another review card. */

export type StaleAcceptApply = {
	tabId: string;
	staleRoundId?: string;
	threadId?: string;
	newString?: string;
};

/** A stale-accept render commits every `edit_doc` / `write_doc` on the
 * tab the user accepted. The render is dedicated to applying that one
 * change; matching only on `new_string` would miss an adapted replacement. */
export function matchesStaleAcceptApply(
	ctx: StaleAcceptApply | null | undefined,
	tabId: string
): boolean {
	return !!ctx && ctx.tabId === tabId;
}

export function isStaleAcceptFollowup(trigger: string | undefined): boolean {
	return /^The user clicked Accept on your previous edit/.test(trigger ?? '');
}
