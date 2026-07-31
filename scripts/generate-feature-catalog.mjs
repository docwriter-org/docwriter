#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const C = 'Covered';
const T = 'Thin';
const M = 'Missing';
const S = 'Stale';

/**
 * Each tuple starts with [area, feature]. Older rows retain the coverage notes
 * from the 2026 documentation audit, but those notes are historical input to
 * the rewrite and are not emitted as current catalog data. The generated
 * catalog records the one page that now owns each shipped feature.
 */
const pageFeatures = {
	'introduction': [
		['Workspace', 'Open any local folder', C, 'Install, Quickstart, and Tabs'],
		['Agent', 'Work across several open files', C, 'Steering and Delegating'],
		['Agent', 'Use shell commands, web research, and code execution', C, 'Introduction and Delegating']
	],
	'connect-provider': [
		['Models', 'Choose Claude, OpenAI, Codex, Cursor, or Pi', M, 'The docs describe Claude only'],
		['Models', 'Choose provider and model from header pills', M, 'The interface docs put model selection under Settings'],
		['Models', 'Store and manage API keys in Settings', M, 'No page'],
		['Models', 'Use Claude or Codex login instead of an API key', M, 'No provider guide'],
		['Models', 'Use Pi with Together, Gemini, OpenAI, or Anthropic keys', M, 'No provider guide'],
		['Models', 'Understand credential precedence and global key storage', M, 'No page'],
		['Models', 'Search models and add a custom model', M, 'No page'],
		['Models', 'Start a fresh session when switching providers', M, 'No page'],
		['Models', 'Restore provider and model when resuming a session', M, 'No page'],
		['Models', 'Understand provider-specific tools and skill support', M, 'No page'],
		['Models', 'See whether each provider uses a key or an existing login', M, 'No page']
	],
	'write/files-and-tabs': [
		['Workspace', 'Create, rename, delete, and move files or folders', T, 'Interface and Tabs omit drag move behavior'],
		['Workspace', 'Drag files from the desktop into the workspace', T, 'Release notes only'],
		['Workspace', 'Import binary files without corrupting them', M, 'No page'],
		['Workspace', 'Open and restore tabs', C, 'Tabs'],
		['Workspace', 'Rename a tab, copy its path, or delete its file', T, 'Tabs omits context menu actions'],
		['Workspace', 'Close a tab without deleting its file', C, 'Tabs'],
		['Workspace', 'See a combined pending work badge on tabs', T, 'Tabs covers pending edits but not unresolved comments'],
		['Workspace', 'Edit Markdown and other text files', C, 'Editor and Tabs'],
		['Workspace', 'Keep .docwriter visible in the file tree', T, 'Tabs mentions obsolete state.json examples']
	],
	'write/editor': [
		['Editor', 'Edit plain source while visual overlays render above it', S, 'Editor describes a WYSIWYG Markdown editor'],
		['Editor', 'Style headings, lists, quotes, rules, and inline Markdown', T, 'Editor is inaccurate about source markers'],
		['Editor', 'Preview Markdown tables and show or hide table source', M, 'No page'],
		['Editor', 'Style fenced code blocks and language labels', M, 'No page'],
		['Editor', 'Comment source with syntax chosen by file extension', M, 'No page'],
		['Review', 'Undo and redo user changes and accepted agent changes', S, 'Behavior claims conflict across pages']
	],
	'write/images-and-diagrams': [
		['Workspace', 'Paste or drop images into a document', M, 'No page'],
		['Workspace', 'Save pasted images under assets and insert Markdown', M, 'No page'],
		['Editor', 'Preview Markdown images and bare image URLs', M, 'No page'],
		['Editor', 'Turn a pasted URL into an image or selected text link', M, 'No page'],
		['Editor', 'Preview links from OpenGraph data on hover', M, 'No page'],
		['Editor', 'Preview raw SVG and show or hide its source', M, 'No page'],
		['Editor', 'Render interactive D3 blocks in a sandboxed frame', M, 'No page'],
		['Agent', 'Attach images to a prompt', T, 'Release notes only'],
		['Agent', 'Read image files from the workspace', T, 'Release notes only']
	],
	'write/find-and-appearance': [
		['Editor', 'Find text and move between matches', C, 'Editor and Shortcuts'],
		['Editor', 'Toggle case sensitive find', T, 'Release notes only'],
		['Editor', 'Generate an outline from Markdown headings', C, 'Editor and Interface'],
		['Editor', 'Wrap lines, show line numbers, and choose a font size', C, 'Editor'],
		['Editor', 'Choose Light, Dark, Solarized, or Monokai themes', M, 'No page'],
		['Editor', 'Resize or hide the sidebar and file tree', T, 'Interface covers visibility but not drag resizing'],
		['Editor', 'Use responsive paper, gutter, preview, and dock layouts', M, 'No page']
	],
	'write/pdfs-and-other-files': [
		['Workspace', 'Open PDF files as in-app viewer tabs', S, 'Tabs says PDFs open in a separate preview window'],
		['Workspace', 'Preview other binary files without opening them as text', T, 'Tabs and release notes'],
		['Workspace', 'Use split preview for generated output', S, 'Preview describes only a popup'],
		['Automation', 'Open output in a popup or resizable side pane', S, 'Preview covers only popup behavior'],
		['Automation', 'Open raw preview output in a new browser window', M, 'No page']
	],
	'agent/ask-and-steer': [
		['Agent', 'Wake automatically or with a shortcut', C, 'Steering'],
		['Agent', 'See the three second idle countdown', T, 'Steering omits the current dock'],
		['Agent', 'Send a typed prompt', C, 'Quickstart and Steering'],
		['Agent', 'Run a prompt with no open tab and create files', M, 'No page'],
		['Agent', 'Queue prompts during a run', C, 'Steering'],
		['Agent', 'Expand or collapse the floating agent dock', M, 'No current interface page'],
		['Agent', 'See queued message badges and a wake up nudge', M, 'No page'],
		['Agent', 'See the current in progress turn pinned above history', M, 'No page'],
		['Agent', 'See failed run toasts with authentication recovery hints', T, 'Observability covers Claude only']
	],
	'agent/agent-behavior': [
		['Agent', 'Pause all agent activity by double clicking the pill', C, 'Agent behavior'],
		['Agent', 'Mute diffs while the agent continues to work', C, 'Agent behavior'],
		['Agent', 'Cancel the current run by clicking the active pill', C, 'Agent behavior'],
		['Customize', 'Set Low, Medium, or High autonomy', C, 'Agent behavior']
	],
	'agent/selected-text-and-directives': [
		['Agent', 'Give feedback on selected text', C, 'Feedback popup'],
		['Agent', 'Use selection feedback entirely from the keyboard', C, 'Feedback popup and Shortcuts'],
		['Agent', 'Choose direct edit or plan first for selected text', C, 'Feedback popup'],
		['Agent', 'Use AI smell feedback as a plan first quick action', T, 'Feedback popup omits the behavior'],
		['Agent', 'Use quick feedback actions and recent actions', C, 'Feedback popup'],
		['Agent', 'Leave inline directives while writing', C, 'Inline directives'],
		['Agent', 'Retry automatically when an inline directive is ignored', M, 'No page'],
		['Review', 'Freeze text that the agent cannot change', C, 'Rules and Feedback popup']
	],
	'agent/plans-and-long-tasks': [
		['Agent', 'Ask for a plan before a chat request', T, 'Steering mentions the toggle only'],
		['Agent', 'Approve, dismiss, or reject a plan with feedback', M, 'No page'],
		['Agent', 'Answer single or multiple agent questions', C, 'Steering'],
		['Agent', 'Continue after an unanswered question times out', T, 'Steering gives the timeout only'],
		['Agent', 'Delegate long work to subagents', C, 'Delegating tasks'],
		['Agent', 'Use Plan first in the chat popover', T, 'No complete procedure']
	],
	'agent/review-edits': [
		['Review', 'See proposed text inline', S, 'Several pages name removed panes'],
		['Review', 'Accept or reject one or all edits', C, 'Reviewing edits'],
		['Review', 'Copy part of a proposal', C, 'Reviewing edits'],
		['Review', 'Group proposed edits under their feedback thread', M, 'No current gutter tour'],
		['Review', 'Pin diffs so they remain visible after a card closes', M, 'No page'],
		['Review', 'Hover an edit row to flash its matching text', M, 'No page'],
		['Review', 'Treat loose edits differently from thread edits', M, 'No page'],
		['Review', 'Disable stale edits and regenerate them against current text', M, 'No page'],
		['Review', 'Show tiny edits more subtly than large edits', M, 'No page'],
		['Review', 'Flash accepted text after an edit lands', M, 'No page'],
		['Review', 'Show accepted AI-written text', C, 'Reviewing edits'],
		['Review', 'Toggle AI-written text highlights on or off', M, 'No page'],
		['Review', 'Remove AI provenance when the user rewrites marked text', C, 'Reviewing edits']
	],
	'agent/comments-and-critique': [
		['Review', 'Discuss changes in comment threads', C, 'Comments'],
		['Review', 'Open inline comment pills and recover detached threads', T, 'Comments omits current states'],
		['Review', 'Resolve or reopen a thread', C, 'Comments'],
		['Review', 'Approve an agent explanation before it proposes an edit', T, 'Comments covers the action briefly'],
		['Review', 'Run built in or custom critique passes', C, 'Steering'],
		['Customize', 'Create a reviewer with a name, mascot, color, and prompt', C, 'Steering']
	],
	'customize/rules': [
		['Customize', 'Manage rules from the toolbar pill bar', S, 'Rules points to Settings'],
		['Customize', 'Create rules, examples, and agent proposed rules', C, 'Rules'],
		['Customize', 'Apply all rules and confirm which tabs to check', M, 'No page'],
		['Customize', 'Accept proposed writing rules from messages', C, 'Writing rules'],
		['Customize', 'Wake the agent after adding a rule', M, 'No page']
	],
	'customize/references': [
		['Customize', 'Add writing references', C, 'References'],
		['Customize', 'Add the current file, pasted prose, or a URL as a reference', C, 'References'],
		['Customize', 'Wake the agent after adding a reference', M, 'No page']
	],
	'customize/skills': [
		['Customize', 'Install, enable, run, and remove skills in the UI', M, 'Skills covers files only'],
		['Customize', 'Add a skill from GitHub shorthand or a local path', M, 'No page'],
		['Customize', 'Ask the agent to find or create a vaguely named skill', M, 'No page'],
		['Customize', 'Run an enabled skill as a slash command', M, 'No page'],
		['Customize', 'Use bundled plain-writing and hooks-creator skills', S, 'Skills lists only one bundled skill']
	],
	'agent/sessions': [
		['Sessions', 'Browse, search, and switch sessions', M, 'Sessions covers reset only'],
		['Sessions', 'Start a new session without changing workspace settings', S, 'Sessions names an old menu location'],
		['Sessions', 'Clear queued work, pending edits, cost, and scratch on reset', M, 'No page'],
		['Sessions', 'Recover stale Cursor or Pi sessions automatically', M, 'No page']
	],
	'agent/activity-and-transcript': [
		['Sessions', 'Inspect current activity and full transcripts', S, 'The docs assume a fixed right pane'],
		['Sessions', 'Filter transcripts by role, tool, or search text', T, 'Observability covers some filters'],
		['Sessions', 'Expand tool calls, messages, thinking, and the system prompt', T, 'Observability is incomplete'],
		['Sessions', 'Inspect context window use by content type', M, 'No page'],
		['Sessions', 'Export a transcript as JSON', M, 'No page'],
		['Sessions', 'See token use and session cost', T, 'Observability omits current locations'],
		['Sessions', 'Choose verbose or minimal history detail', T, 'Observability omits the Settings control'],
		['Sessions', 'Expand long agent messages and follow subagent progress', M, 'No page'],
		['Sessions', 'Open the full transcript from the agent dock', T, 'No complete procedure']
	],
	'automation/hooks': [
		['Customize', 'Create and review shell hooks', C, 'Hooks and Events'],
		['Automation', 'Run hooks on agent events', C, 'Hooks and Events'],
		['Automation', 'Start from pdflatex, Pandoc HTML or PDF, Mermaid, or Git templates', T, 'Hooks omits part of the template set'],
		['Automation', 'Edit, enable, disable, remove, or run a hook manually', C, 'Hooks'],
		['Automation', 'Review a hook proposed by the agent', T, 'The docs point to an old review location'],
		['Automation', 'Run hooks with full shell access in the workspace', T, 'The docs omit the safety boundary']
	],
	'automation/events': [
		['Automation', 'Use file, stem, and tool placeholders in hook commands', C, 'Hooks']
	],
	'automation/preview': [
		['Automation', 'Preview PDF, HTML, SVG, and Mermaid output', C, 'Preview and Guides'],
		['Automation', 'Reload preview output while preserving scroll and zoom', T, 'Preview covers reload but not preserved state']
	],
	'automation/latex-and-synctex': [
		['Workspace', 'Use forward and reverse SyncTeX between source and PDF', T, 'Preview covers part of the flow'],
		['Automation', 'Find a same name PDF automatically for a TeX file', M, 'No page']
	],
	'guides/blog-with-research': [
		['Agent', 'Research a claim and propose a supported citation', C, 'Research guide']
	],
	'guides/overleaf': [
		['Automation', 'Edit, build, preview, and sync an Overleaf project', C, 'Overleaf guide']
	],
	'automation/example-projects': [
		['Automation', 'Publish Markdown as HTML or PDF with Pandoc', T, 'The current guide is a stub'],
		['Automation', 'Generate Mermaid diagrams as SVG files', T, 'The current guide is a stub'],
		['Automation', 'Use Git hooks for writing project commits and pushes', T, 'The current guide is a stub']
	],
	'help/provider-errors': [
		['Reference', 'Understand what providers receive from open tabs', T, 'Steering covers paths and diffs only']
	],
	'help/storage-and-backups': [
		['Reference', 'Back up workspace text and DocWriter state', C, 'Storage and backups']
	],
	'reference/how-it-works': [
		['Reference', 'Understand storage and synchronization', C, 'How DocWriter saves your work'],
		['Reference', 'Understand workspace files and database state', C, 'How DocWriter saves your work']
	],
	'help/external-edits': [
		['Workspace', 'Reload after files change outside DocWriter', T, 'CLI covers watch mode but not in-app reload'],
		['Workspace', 'Let an external file edit replace stale CRDT state', M, 'No recovery documentation'],
		['Reference', 'Watch external files and reload the browser', C, 'CLI']
	],
	'help/recovery': [
		['Reference', 'Restart automatically after a server crash', C, 'CLI'],
		['Reference', 'Recover from a server restart or WebSocket mismatch', M, 'No troubleshooting page'],
		['Reference', 'Use the agent scratch workspace until a new session', M, 'No page']
	],
	'help/privacy-and-safety': [
		['Workspace', 'Block paths and symlinks outside the workspace', T, 'Tabs mentions the boundary without a safety page'],
		['Reference', 'Understand key storage, shell hooks, and path safety', M, 'No privacy or safety page'],
		['Reference', 'Bind to a custom host or expose DocWriter on a LAN', C, 'CLI']
	],
	'help/shortcuts': [
		['Reference', 'Use current editor, feedback, review, PDF, and dialog shortcuts', S, 'The shortcut page includes removed controls']
	],
	'help/command-line': [
		['Reference', 'Use the command line', S, 'The page has Claude-only flags and auth']
	],
	'contribute/architecture': [
		['Reference', 'Follow the full system architecture', C, 'Contributor architecture']
	]
};

const features = Object.entries(pageFeatures).flatMap(([targetPage, rows]) =>
	rows.map(([area, feature], index) => ({
		id: `${targetPage.replaceAll('/', '-')}-${String(index + 1).padStart(2, '0')}`,
		area,
		feature,
		targetPage
	}))
);

if (features.some((feature) => !feature.targetPage)) {
	throw new Error('Every feature must have a target page');
}

const output = {
	featureCount: features.length,
	unassignedCount: features.filter((feature) => !feature.targetPage).length,
	features
};

await writeFile(
	resolve('docs/feature-catalog.json'),
	`${JSON.stringify(output, null, 2)}\n`,
	'utf8'
);

console.log(`Wrote ${features.length} assigned features to docs/feature-catalog.json`);
