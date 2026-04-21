import './src/lib/server/dom-shim';
import * as Y from 'yjs';
import Database from 'better-sqlite3';
import { serializeYDocToMarkdown } from './src/lib/server/ydoc-markdown';

const db = new Database('/tmp/docwriter-final-test/.docwriter/docwriter.db');
const rows = db.prepare('SELECT seq, origin, "update" AS buf FROM yjs_updates WHERE tab_id = ? ORDER BY seq').all('amarkdown.md') as any[];

const doc = new Y.Doc();
for (const row of rows) {
  doc.transact(() => Y.applyUpdate(doc, new Uint8Array(row.buf)), row.origin);
  if (row.seq >= 550 && row.seq <= 570) {
    const md = serializeYDocToMarkdown(doc, 'markdown');
    console.log(`seq ${row.seq} (${row.origin}, ${row.buf.byteLength}b) → md=${md.length}b`);
  }
}

const frag = doc.getXmlFragment('default');
console.log();
console.log(`final fragment length: ${frag.length}`);
frag.forEach((child: any, i: number) => {
  if (i < 20) console.log(`  [${i}] ${child.toString().slice(0, 100)}`);
});
