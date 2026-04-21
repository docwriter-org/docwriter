import './src/lib/server/dom-shim';
import * as Y from 'yjs';
import Database from 'better-sqlite3';

const db = new Database('/tmp/docwriter-final-test/.docwriter/docwriter.db');
const rows = db.prepare('SELECT seq, origin, "update" AS buf FROM yjs_updates WHERE tab_id = ? ORDER BY seq').all('amarkdown.md') as any[];

const doc = new Y.Doc();
for (const row of rows) {
  doc.transact(() => Y.applyUpdate(doc, new Uint8Array(row.buf)), row.origin);
}
const reviewMap = doc.getMap('review');
const rounds = reviewMap.get('pendingRounds') as any[] | undefined;
console.log('pending rounds:', rounds ? rounds.length : 0);
if (rounds && rounds.length) {
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    console.log(`round ${i}: id=${r.id.slice(0, 10)} trigger=${r.trigger} stepCount=${r.stepCount}`);
    console.log(`  beforeMd[${r.beforeMd.length}]: ${r.beforeMd.slice(0, 100)}`);
    console.log(`  afterMd[${r.afterMd.length}]: ${r.afterMd.slice(0, 200)}`);
  }
}
