import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { allocate, openRegistry } from '../registry.js';

describe('registry', () => {
	let dir;
	afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

	it('allocates distinct uids and port pairs from the sequence', () => {
		expect(allocate(1, { uidBase: 20000, portBase: 41000 })).toEqual({ uid: 20001, appPort: 41000, wsPort: 41001 });
		expect(allocate(3, { uidBase: 20000, portBase: 41000 })).toEqual({ uid: 20003, appPort: 41004, wsPort: 41005 });
	});

	it('is stable per user and survives reopen', () => {
		dir = mkdtempSync(join(tmpdir(), 'dw-registry-'));
		const path = join(dir, 'r.db');
		let reg = openRegistry(path, { uidBase: 20000, portBase: 41000 });
		const a = reg.getOrCreate('gh:1', 'alice');
		const b = reg.getOrCreate('gh:2', 'bob');
		expect(a.uid).toBe(20001);
		expect(b.appPort).toBe(41002);
		expect(reg.getOrCreate('gh:1', 'alice-renamed')).toMatchObject({ uid: 20001, appPort: 41000, login: 'alice-renamed' });
		reg.close();
		reg = openRegistry(path, { uidBase: 20000, portBase: 41000 });
		expect(reg.get('gh:2')).toMatchObject({ uid: 20002, wsPort: 41003 });
		expect(reg.getOrCreate('gh:3', 'carol').uid).toBe(20003);
		expect(reg.all().map((u) => u.login)).toEqual(['alice-renamed', 'bob', 'carol']);
		reg.close();
	});
});
