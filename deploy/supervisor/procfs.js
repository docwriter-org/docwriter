/** Small /proc helpers: find the app process inside a bwrap tree. */
import { readdirSync, readFileSync } from 'node:fs';

/** Map of pid → ppid for every process, by scanning /proc/N/stat. */
export function processTable(procRoot = '/proc') {
	const table = new Map();
	for (const name of readdirSync(procRoot)) {
		if (!/^\d+$/.test(name)) continue;
		try {
			const stat = readFileSync(`${procRoot}/${name}/stat`, 'utf8');
			// "pid (comm) state ppid ..." — comm may contain spaces/parens, so
			// parse from the last ')'.
			const close = stat.lastIndexOf(')');
			const comm = stat.slice(stat.indexOf('(') + 1, close);
			const ppid = parseInt(stat.slice(close + 2).split(' ')[1], 10);
			table.set(parseInt(name, 10), { ppid, comm });
		} catch {
			/* raced with exit */
		}
	}
	return table;
}

/**
 * The pid of the app's Node process under `rootPid`: the root itself when
 * it is Node (sandbox=none), else the nearest descendant named `node`
 * (bwrap → its pid-1 helper → node). Null when it cannot be found.
 */
export function findAppPid(rootPid, table = processTable()) {
	if (table.get(rootPid)?.comm === 'node') return rootPid;
	const queue = [rootPid];
	const seen = new Set();
	while (queue.length) {
		const parent = queue.shift();
		for (const [pid, { ppid, comm }] of table) {
			if (ppid !== parent || seen.has(pid)) continue;
			if (comm === 'node') return pid;
			seen.add(pid);
			queue.push(pid);
		}
	}
	return null;
}
