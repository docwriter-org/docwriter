/**
 * Recovery for a style pass the server was killed during.
 *
 * A run lives in run-manager's in-memory job map while its progress is written
 * to the profile as it goes. Kill the process mid-pass and the profile is left
 * saying `analyzing` with a `lastRun` marked running, forever: the pill never
 * settles, and reopening the dialog reconnects to an event stream that 404s
 * because the job is gone.
 *
 * This lives in its own module, not run-manager, so that hooks.server.ts can
 * call it without pulling run-manager's provider imports (and the Anthropic
 * SDKs behind them) into its module graph — an edge that would re-execute the
 * hooks module scope on every style-analysis edit in dev.
 *
 * The caller must invoke it once per process, at startup, before any request
 * can start a run. That once-per-process contract is what makes it safe to
 * treat a running `lastRun` as dead without consulting the live job map: at
 * cold boot there is none, and HMR re-executions are the caller's job to guard.
 */
import { deriveStyleProfileStatus } from '$lib/style-profile';
import { readStyleProfile, writeStyleProfile } from './profile-store';

export function failInterruptedStyleRun(): void {
	try {
		const profile = readStyleProfile();
		const lastRun = profile?.lastRun;
		if (!profile || !lastRun) return;
		if (!['queued', 'running'].includes(lastRun.status)) return;
		writeStyleProfile({
			...profile,
			// Propositions from specialists that finished before the stop are
			// already saved, so status is derived from what survived rather
			// than blanket-failed.
			status: deriveStyleProfileStatus(profile.propositions),
			lastRun: {
				...lastRun,
				status: 'error',
				phase: 'error',
				completedAt: Date.now(),
				error: 'DocWriter stopped while this pass was running. Run another pass.',
				specialists: lastRun.specialists.map((specialist) =>
					['pending', 'running'].includes(specialist.status)
						? { ...specialist, status: 'error' as const, completedAt: Date.now() }
						: specialist
				)
			}
		});
	} catch {
		// A profile we cannot read is not one we can repair, and failing here
		// would take the whole server down on boot.
	}
}
