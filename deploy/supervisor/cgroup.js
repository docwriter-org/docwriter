/**
 * Per-user memory and pid limits through cgroup v2, without systemd-run.
 *
 * The supervisor's service unit must have `Delegate=yes`. At boot we move
 * ourselves into a `self/` leaf of our own cgroup (the "no internal
 * processes" rule forbids enabling controllers for children while we sit in
 * the parent), enable memory and pids for children, and then give each user
 * process its own leaf. Any failure degrades to "no limits" with a warning
 * rather than refusing to run: a laptop without delegation still works.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { warn, info } from './log.js';

const CGROUP_ROOT = '/sys/fs/cgroup';

export function createCgroups({ enabled = true } = {}) {
	let base = null;

	function ownCgroupPath() {
		const line = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::'));
		if (!line) throw new Error('cgroup v2 not in use');
		return join(CGROUP_ROOT, line.slice(3).trim());
	}

	function init() {
		if (!enabled) return false;
		try {
			const own = ownCgroupPath();
			const self = join(own, 'self');
			mkdirSync(self, { recursive: true });
			writeFileSync(join(self, 'cgroup.procs'), String(process.pid));
			writeFileSync(join(own, 'cgroup.subtree_control'), '+memory +pids');
			base = own;
			info('cgroup limits enabled', { base });
			return true;
		} catch (err) {
			warn('cgroup limits unavailable; running without memory caps', { reason: String(err?.message ?? err) });
			base = null;
			return false;
		}
	}

	function pathFor(uid) {
		return base ? join(base, `user-${uid}`) : null;
	}

	/** Create the user's leaf with limits and move `pid` into it. */
	function attach(uid, pid, { memoryMax, pidsMax }) {
		const path = pathFor(uid);
		if (!path) return null;
		try {
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, 'memory.max'), toBytes(memoryMax));
			writeFileSync(join(path, 'memory.swap.max'), '0');
			writeFileSync(join(path, 'pids.max'), String(pidsMax));
			writeFileSync(join(path, 'cgroup.procs'), String(pid));
			return path;
		} catch (err) {
			warn('could not attach process to cgroup', { uid, pid, reason: String(err?.message ?? err) });
			return null;
		}
	}

	/** SIGKILL everything in the leaf (kernel 5.14+), then remove it. */
	function kill(uid) {
		const path = pathFor(uid);
		if (!path || !existsSync(path)) return false;
		try {
			writeFileSync(join(path, 'cgroup.kill'), '1');
			return true;
		} catch {
			return false;
		}
	}

	function remove(uid) {
		const path = pathFor(uid);
		if (!path || !existsSync(path)) return;
		try {
			rmSync(path, { recursive: false, force: true });
		} catch {
			/* still has processes; a later remove will get it */
		}
	}

	/** Did the kernel's OOM killer fire in this leaf? */
	function oomKills(uid) {
		const path = pathFor(uid);
		if (!path) return 0;
		try {
			const events = readFileSync(join(path, 'memory.events'), 'utf8');
			const m = events.match(/^oom_kill (\d+)$/m);
			return m ? parseInt(m[1], 10) : 0;
		} catch {
			return 0;
		}
	}

	return { init, attach, kill, remove, oomKills, get enabled() { return base !== null; } };
}

/** "1500M" → bytes as a string; plain integers pass through. */
export function toBytes(value) {
	const m = String(value).trim().match(/^(\d+)([kKmMgG]?)$/);
	if (!m) throw new Error(`Bad size: ${value}`);
	const n = parseInt(m[1], 10);
	const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()];
	return String(n * mult);
}
