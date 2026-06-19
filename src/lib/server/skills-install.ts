/**
 * Sync DocWriter-managed skills into the native discovery folders used by
 * provider harnesses. Claude reads `.claude/skills`; Codex and Pi both read
 * `.agents/skills`.
 */
import { syncSkillInstallations } from './skills-config';

export function installBundledSkills() {
	try {
		syncSkillInstallations();
	} catch (e) {
		console.warn('[skills-install] Failed to sync skills', e);
	}
}
