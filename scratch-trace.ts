import './src/lib/server/dom-shim';
import * as Y from 'yjs';
import Database from 'better-sqlite3';
import { serializeYDocToMarkdown } from './src/lib/server/ydoc-markdown';

const db = new Database('/tmp/docwriter-final-test/.docwriter/docwriter.db');
const rows = db.prepare('SELECT seq, origin, "update" AS buf FROM yjs_updates WHERE tab_id = ? ORDER BY seq').all('amarkdown.md') as any[];

const doc = new Y.Doc();
let prevLen = 0;
for (const row of rows) {
  const before = serializeYDocToMarkdown(doc, 'markdown').length;
  doc.transact(() => Y.applyUpdate(doc, new Uint8Array(row.buf)), row.origin);
  const after = serializeYDocToMarkdown(doc, 'markdown').length;
  if (row.origin === 'agent' || Math.abs(after - before) > 100) {
    console.log(`seq ${row.seq} ${row.origin} ${row.buf.byteLength}b : md ${before} → ${after} (Δ${after - before})`);
  }
}

// At each agent row, print doc state right after
console.log('\n=== after each agent row ===');
const doc2 = new Y.Doc();
for (const row of rows) {
  doc2.transact(() => Y.applyUpdate(doc2, new Uint8Array(row.buf)), row.origin);
  if (row.origin === 'agent') {
    console.log(`\n--- after seq ${row.seq} ---`);
    console.log(serializeYDocToMarkdown(doc2, 'markdown'));
  }
}
