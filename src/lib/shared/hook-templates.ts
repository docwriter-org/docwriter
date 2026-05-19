/** Shared (client + server) library of common build-and-preview hooks
 * the user can add with one click from the Hooks panel. Each entry
 * seeds the add-form fields so the user can tweak before saving. The
 * `description` is shown in the chip's tooltip; the `id` is used as
 * the chip key.
 *
 * Curated to cover the most common writing-tool toolchains: LaTeX
 * (latexmk recommended; pdflatex as a fallback), pandoc → HTML / PDF,
 * and Mermaid diagrams. Add more here when users ask. */

export type HookEvent =
	| 'PreToolUse'
	| 'PostToolUse'
	| 'PostToolUseFailure'
	| 'UserPromptSubmit'
	| 'Stop'
	| 'SubagentStop'
	| 'SessionStart'
	| 'SessionEnd'
	| 'Notification';

export interface HookTemplate {
	id: string;
	label: string;
	description: string;
	event: HookEvent;
	matcher?: string;
	command: string;
	output?: string;
}

export const HOOK_TEMPLATES: readonly HookTemplate[] = [
	{
		id: 'pdflatex',
		label: 'pdflatex',
		description:
			'Build the project root (main.tex) when the agent finishes a turn. Runs pdflatex, then bibtex, then pdflatex twice more so cross-references and citations resolve correctly. Each pass passes -synctex=1 so the preview window\'s "double-click PDF to jump to source" feature works. Edit `main` / `main.pdf` below if your entry file is named differently.',
		event: 'Stop',
		command:
			'pdflatex -interaction=nonstopmode -halt-on-error -synctex=1 main.tex && (bibtex main || true) && pdflatex -interaction=nonstopmode -halt-on-error -synctex=1 main.tex && pdflatex -interaction=nonstopmode -halt-on-error -synctex=1 main.tex',
		output: 'main.pdf'
	},
	{
		id: 'git-push-on-stop',
		label: 'Git auto-commit & push',
		description:
			'When the agent finishes a turn (Stop), commit any pending changes and push to the current branch\'s upstream. Requires the workspace to be a git repo with a configured remote.',
		event: 'Stop',
		command:
			'git add -A && (git diff --cached --quiet || (git commit -m "docwriter: auto-commit" && git push))'
	},
	{
		id: 'git-push-on-stop-private',
		label: 'Git auto-commit & push (ignoring LLM artifacts)',
		description:
			'Auto-commit and push, but leave the LLM trail behind: skip .claude/ (agent transcripts), .docwriter/ (CRDT log + session state), and CLAUDE.md (project memory). Use this when the repo is shared and you don\'t want agent context leaking into the remote.',
		event: 'Stop',
		command:
			"git add -A -- ':(exclude).claude' ':(exclude).docwriter' ':(exclude)CLAUDE.md' && (git diff --cached --quiet || (git commit -m \"docwriter: auto-commit\" && git push))"
	},
	{
		id: 'pandoc-html',
		label: 'pandoc HTML',
		description:
			'Render the active .md as HTML on every Edit/Write. Preview reloads with scroll preserved.',
		event: 'PostToolUse',
		matcher: 'Edit|Write',
		command: 'pandoc {{file}} -o {{stem}}.html --standalone',
		output: '{{stem}}.html'
	},
	{
		id: 'pandoc-pdf',
		label: 'pandoc PDF',
		description:
			'Render the active .md as PDF (requires a TeX engine for pandoc).',
		event: 'PostToolUse',
		matcher: 'Edit|Write',
		command: 'pandoc {{file}} -o {{stem}}.pdf',
		output: '{{stem}}.pdf'
	},
	{
		id: 'mermaid',
		label: 'Mermaid (mmdc)',
		description: 'Render a Mermaid .mmd file as SVG. Requires @mermaid-js/mermaid-cli.',
		event: 'PostToolUse',
		matcher: 'Edit|Write',
		command: 'mmdc -i {{file}} -o {{stem}}.svg',
		output: '{{stem}}.svg'
	}
] as const;
