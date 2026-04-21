import './src/lib/server/dom-shim';
import * as Y from 'yjs';
import Database from 'better-sqlite3';

const db = new Database('/tmp/docwriter-final-test/.docwriter/docwriter.db');
const row = db.prepare('SELECT "update" AS buf FROM yjs_updates WHERE tab_id = ? AND seq = ?').get('amarkdown.md', 523) as any;
const decoded = Y.decodeUpdate(new Uint8Array(row.buf));
console.log(`structs: ${decoded.structs.length}`);
decoded.structs.forEach((s: any, i: number) => {
  console.log(`  [${i}] ${s.constructor.name}`);
  try { console.log(`    content: ${JSON.stringify(s.content).slice(0, 200)}`); } catch {}
  try { console.log(`    parentSub: ${JSON.stringify(s.parentSub).slice(0, 100)}`); } catch {}
});
console.log(`ds clients:`, Object.keys(decoded.ds.clients));
for (const [client, ranges] of Object.entries(decoded.ds.clients) as any) {
  console.log(`  client ${client}:`, ranges);
}
