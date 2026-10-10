import { describe, expect, it } from 'vitest';
import { DOC_TOOLS } from '$lib/server/mcp-doc-tools';
import { buildToolDefinitions } from './tool-handlers';

const definitions = buildToolDefinitions();
const byName = new Map(definitions.map((def) => [def.name, def]));

describe('buildToolDefinitions', () => {
	it('gives the other providers the same document tool descriptions as Claude', () => {
		for (const tool of DOC_TOOLS) {
			expect(byName.get(tool.name)?.description).toBe(tool.description);
		}
	});

	it('converts each document tool schema to JSON Schema with its argument descriptions', () => {
		const edit = byName.get('edit_doc')!.inputSchema as {
			type: string;
			properties: Record<string, { type?: string; description?: string }>;
			required: string[];
			$schema?: string;
		};
		expect(edit.type).toBe('object');
		expect(edit.$schema).toBeUndefined();
		expect(edit.required).toEqual(['file_path', 'old_string', 'new_string']);
		expect(edit.properties.replace_all.type).toBe('boolean');
		expect(edit.properties.thread_id.description).toMatch(/A passage has one thread/);

		const comment = byName.get('comment_doc')!.inputSchema as {
			properties: Record<string, { type?: string; description?: string }>;
		};
		expect(comment.properties.occurrence_index.type).toBe('integer');
		expect(comment.properties.occurrence_index.description).toMatch(/Zero-based occurrence/);
	});

	it('keeps every tool and the original order', () => {
		expect(definitions.map((def) => def.name)).toEqual([
			'edit_doc',
			'read_doc',
			'write_doc',
			'read_skill',
			'add_skill',
			'review_action',
			'propose_rule',
			'propose_hook',
			'comment_doc',
			'reply_to_comment',
			'list_threads'
		]);
	});

	it('returns an error result instead of throwing when required arguments are missing', async () => {
		const result = await byName.get('edit_doc')!.execute({ file_path: 'essay.md' });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/edit_doc received invalid arguments/);
	});

	it('treats null optional arguments as omitted', async () => {
		const result = await byName.get('list_threads')!.execute({
			file_path: '.docwriter/agent/scratch/notes.md',
			include_dismissed: null
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/cannot be used on scratch paths/);
	});
});
