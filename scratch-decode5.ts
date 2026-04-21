import './src/lib/server/dom-shim';
import * as Y from 'yjs';
import Database from 'better-sqlite3';

const db = new Database('/tmp/docwriter-final-test/.docwriter/docwriter.db');
const row = db.prepare('SELECT "update" AS buf FROM yjs_updates WHERE tab_id = ? AND seq = ?').get('amarkdown.md', 523) as any;
const bytes = new Uint8Array(row.buf);
console.log('raw bytes (hex):', Buffer.from(bytes).toString('hex'));
console.log('raw bytes length:', bytes.length);

// Try decoding via diffUpdate vs state vector
const doc = new Y.Doc();
doc.on('afterTransaction', (tr: any) => {
  console.log('transaction:', {
    deleted: tr.deleteSet.clients.size,
    changed: Array.from(tr.changed.keys()).map((t: any) => t?.constructor?.name),
  });
});

// Apply the prior ops first
const prior = db.prepare('SELECT "update" AS buf, origin FROM yjs_updates WHERE tab_id = ? AND seq < 523 ORDER BY seq').all('amarkdown.md') as any[];
for (const p of prior) {
  doc.transact(() => Y.applyUpdate(doc, new Uint8Array(p.buf)), p.origin);
}
console.log('--- after prior rows, before applying 523 ---');
console.log('fragment length:', doc.getXmlFragment('default').length);

console.log('\n--- applying seq 523 ---');
doc.transact(() => Y.applyUpdate(doc, bytes), 'user');
console.log('fragment length after:', doc.getXmlFragment('default').length);

// What's in the fragment's delete set now?
const state = Y.encodeStateAsUpdate(doc);
const decoded = Y.decodeUpdate(state);
console.log('total doc structs now:', decoded.structs.length);
console.log('total doc deletes now:', Object.entries(decoded.ds.clients).reduce((s, [,r]) => s + (r as any).reduce((x: number, y: any) => x + y.len, 0), 0));
