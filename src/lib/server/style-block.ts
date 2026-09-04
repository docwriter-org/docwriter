/**
 * The `<author_style>` block of a turn prompt: the learned author style.
 *
 * The full instructions go out when the transcript has not seen them yet: the
 * first turn of a session, and any turn where the published instructions
 * changed. Every other turn carries a one-line reminder instead. Repeating the
 * whole list on every turn buried the author's own words under the same eight
 * bullets each time; sending it only on the turn where the profile changed (an
 * earlier version) left every later turn with nothing saying a style existed,
 * and a compacted or fresh transcript with no way to find it. The reminder
 * names the skill, which keeps the instructions and the passages behind them.
 */
import { publishedStylePropositions, type StyleProfile } from '$lib/style-profile';

const DEFAULT_SKILL_ID = 'author-style';

/** What the agent is asked to follow: the active instructions and the skill
 * that carries them. Deterministic, so a turn can tell whether the transcript
 * already holds the current list. Empty when no style is published. */
export function snapshotStyle(profile: StyleProfile | null): string {
	const active = publishedStylePropositions(profile);
	if (active.length === 0) return '';
	return JSON.stringify({
		skill: profile?.skillId ?? DEFAULT_SKILL_ID,
		instructions: active.map((proposition) => proposition.instruction)
	});
}

export interface StyleBlockInput {
	profile: StyleProfile | null;
	/** The snapshot the transcript was last given, or null when unknown. */
	prior: string | null;
	/** True when this turn starts a transcript that has seen nothing yet. */
	fresh: boolean;
}

export interface StyleBlockResult {
	/** Block text, or null when there is nothing to say this turn. */
	text: string | null;
	/** Snapshot to store for the next turn's comparison. */
	snapshot: string;
}

export function buildStyleBlock({ profile, prior, fresh }: StyleBlockInput): StyleBlockResult {
	const snapshot = snapshotStyle(profile);
	const skill = profile?.skillId ?? DEFAULT_SKILL_ID;
	const transcriptHas = !fresh && !!prior;

	if (!snapshot) {
		// A style the transcript was told about is gone: say so once, so the
		// agent stops following instructions that no longer apply.
		if (transcriptHas) {
			return {
				text: 'The learned style I gave you earlier this session is no longer active. Write by my rules and your own judgement.',
				snapshot
			};
		}
		return { text: null, snapshot };
	}

	if (transcriptHas && prior === snapshot) {
		return {
			text: `How I write: unchanged since my last message. Keep to the instructions I gave earlier this session; the \`${skill}\` skill holds them, with the passages behind each.`,
			snapshot
		};
	}

	const lead = transcriptHas
		? 'How I write has changed since my last message. This replaces what I said before. Follow it whenever you draft or revise prose here, unless I ask for something different this turn.'
		: 'How I write, learned from a handful of pieces I wrote. Follow this whenever you draft or revise prose here, unless I ask for something different this turn.';
	const active = publishedStylePropositions(profile);
	return {
		text: [
			lead,
			'',
			...active.map((proposition) => `- ${proposition.instruction}`),
			'',
			'These are tendencies, not rules. Follow the ones that fit and skip the rest. They govern how you write, not what about: take no facts or subject matter from the references. My rules come first.',
			'',
			`Read the \`${skill}\` skill before you write. It holds the passages behind each instruction.`
		].join('\n'),
		snapshot
	};
}
