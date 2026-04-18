// Render lifecycle state. The user and agent write to DIFFERENT files, so we
// don't need a mutex — the OS handles atomic file writes. We only need to
// track the render lifecycle so writeUserDoc knows when NOT to sync to agent.md.
//
// - renderActive: a render is in progress (agent is working on document.agent.md).
//     While this is true, user writes go only to document.md. The render
//     endpoint's PreToolUse hook syncs user deltas into document.agent.md
//     before each agent Edit tool call.
// - lastSyncedUserMd: snapshot of document.md the last time we synced it into
//     document.agent.md. Used to compute the user's delta for the next sync.

let renderActive = false;
let lastSyncedUserMd = '';

export function startRender(initialUserMd: string) {
	renderActive = true;
	lastSyncedUserMd = initialUserMd;
}
export function endRender() {
	renderActive = false;
	lastSyncedUserMd = '';
}
export function isRenderActive() { return renderActive; }
export function getLastSyncedUserMd() { return lastSyncedUserMd; }
export function setLastSyncedUserMd(md: string) { lastSyncedUserMd = md; }
