import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { serializeYDoc } from '$lib/shared/ydoc-codec';

let workspace: string;
let replayUpdatesInto: (ydoc: Y.Doc, tabId: string) => void;

const TAB = 'research.tex';
// An em dash: the seeder normalizes it to '-', the serializer emits '-',
// so the log text can never equal the bytes on disk.
const FILE_TEXT = '\\section{Intro}\n\nWriting is hard \u2014 very hard.\n';

beforeAll(async () => {
	workspace = mkdtempSync(join(tmpdir(), 'docwriter-reseed-'));
	process.env.DOCWRITER_ROOT = workspace;
	writeFileSync(join(workspace, TAB), FILE_TEXT);
	({ replayUpdatesInto } = await import('./ydoc-persistence'));
});

afterAll(() => {
	rmSync(workspace, { recursive: true, force: true });
});

/** Bump the file's mtime without changing its bytes — what a cloud-sync
 * client (Dropbox/iCloud) does when the machine wakes up. */
function touchFile() {
	const future = new Date(Date.now() + 60_000);
	utimesSync(join(workspace, TAB), future, future);
}

describe('external-edit detection', () => {
	it('does not duplicate content when a reconnecting client survives a reload', () => {
		// Cold start: server hydrates the tab and a browser syncs the same doc.
		const server1 = new Y.Doc();
		replayUpdatesInto(server1, TAB);
		const client = new Y.Doc();
		Y.applyUpdate(client, Y.encodeStateAsUpdate(server1));
		expect(serializeYDoc(client)).toContain('Writing is hard');

		// Sleep: the WS drops, Hocuspocus unloads the doc. On wake the file's
		// mtime is newer (cloud sync) but its bytes are unchanged.
		touchFile();

		// The tab loads again, then the browser reconnects with its old doc.
		const server2 = new Y.Doc();
		replayUpdatesInto(server2, TAB);
		Y.applyUpdate(server2, Y.encodeStateAsUpdate(client));
		Y.applyUpdate(client, Y.encodeStateAsUpdate(server2));

		const occurrences = serializeYDoc(client).split('Writing is hard').length - 1;
		expect(occurrences).toBe(1);
		expect(serializeYDoc(server2)).toBe(serializeYDoc(client));
	});

	it('adopts a genuine external edit without duplicating the document', () => {
		const server1 = new Y.Doc();
		replayUpdatesInto(server1, TAB);
		const client = new Y.Doc();
		Y.applyUpdate(client, Y.encodeStateAsUpdate(server1));

		// The user edits the file in another editor while docwriter is asleep.
		const edited = FILE_TEXT.replace('very hard', 'very very hard');
		writeFileSync(join(workspace, TAB), edited);
		touchFile();

		const server2 = new Y.Doc();
		replayUpdatesInto(server2, TAB);
		expect(serializeYDoc(server2)).toContain('very very hard');

		// The browser that slept through all of this reconnects.
		Y.applyUpdate(server2, Y.encodeStateAsUpdate(client));
		Y.applyUpdate(client, Y.encodeStateAsUpdate(server2));

		const text = serializeYDoc(client);
		expect(text.split('Writing is hard').length - 1).toBe(1);
		expect(text).toContain('very very hard');
		expect(serializeYDoc(server2)).toBe(text);
		// Disk keeps its own bytes; only the Y.Doc was rebased.
		expect(readFileSync(join(workspace, TAB), 'utf-8')).toBe(edited);
	});
});
