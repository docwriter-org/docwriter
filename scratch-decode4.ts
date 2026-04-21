import './src/lib/server/dom-shim';
import * as Y from 'yjs';
import Database from 'better-sqlite3';
import { serializeYDocToMarkdown } from './src/lib/server/ydoc-markdown';

const db = new Database('/tmp/docwriter-final-test/.docwriter/docwriter.db');
const rows = db.prepare('SELECT seq, origin, "update" AS buf FROM yjs_updates WHERE tab_id = ? AND seq <= 524 ORDER BY seq').all('amarkdown.md') as any[];

const doc = new Y.Doc();
for (const row of rows) {
  doc.transact(() => Y.applyUpdate(doc, new Uint8Array(row.buf)), row.origin);
  if (row.seq === 522 || row.seq === 523) {
    const frag = doc.getXmlFragment('default');
    const md = serializeYDocToMarkdown(doc, 'markdown');
    console.log(`\n=== after seq ${row.seq} (${row.origin}, ${row.buf.byteLength}b) ===`);
    console.log(`fragment length: ${frag.length}, md: ${md.length}b`);
    frag.forEach((child: any, i: number) => console.log(`  [${i}] ${child.toString().slice(0, 150)}`));
  }
}
