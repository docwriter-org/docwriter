import { isActiveProposition, type StyleProfile } from '$lib/style-profile';
import {
	readStyleProfile,
	readStyleReport,
	writeStyleProfile
} from './profile-store';
import { compileAuthorStyleSkill } from './skill-compiler';
import { replacePublishedStylePropositions } from './proposition-store';
import { appendStyleStudyEvent } from './study-log';

type SkillCompiler = typeof compileAuthorStyleSkill;

/** Publish the reviewed draft as the live author style. Analysis and
 * calibration only change the SQLite working copy; this is the sole path that
 * rebuilds the generated skill after a normal analysis run. */
export function finalizeStyleProfile(
	compile: SkillCompiler = compileAuthorStyleSkill
): StyleProfile {
	let profile = readStyleProfile();
	const report = readStyleReport();
	if (!profile || !report) throw new Error('Style profile has not been analyzed');
	if (profile.propositions.some((proposition) => proposition.status === 'pending')) {
		throw new Error('Finish or skip every pending proposition before finalizing');
	}
	if (profile.calibrations.some((trial) => ['pending', 'generated', 'error'].includes(trial.status))) {
		throw new Error('Finish or skip every pending comparison before finalizing');
	}
	const active = profile.propositions.filter(isActiveProposition);
	if (!active.length) throw new Error('Keep at least one proposition before finalizing');

	const skill = compile(profile, report, { startsNewVersion: true });
	const publishedAt = Date.now();
	profile = writeStyleProfile({
		...profile,
		skillId: skill.skillId,
		skillPath: skill.skillPath,
		publishedAt,
		publishedAnalyzerVersion: profile.analyzerVersion,
		publishedSourceSnapshotHash: profile.sourceSnapshotHash,
		publishedPropositions: structuredClone(profile.propositions)
	});
	replacePublishedStylePropositions(
		profile.lastRun?.id ?? 'profile',
		profile.publishedPropositions ?? []
	);
	appendStyleStudyEvent('style_finalized', {
		runId: profile.lastRun?.id,
		activeCount: active.length,
		propositionCount: profile.propositions.length,
		publishedAt
	});
	return profile;
}
