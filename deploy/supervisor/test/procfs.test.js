import { describe, expect, it } from 'vitest';
import { findAppPid, processTable } from '../procfs.js';

describe('procfs', () => {
	it('finds node under bwrap and its pid-1 helper, or the root itself', () => {
		const table = new Map([
			[100, { ppid: 1, comm: 'bwrap' }],
			[101, { ppid: 100, comm: 'bwrap' }],
			[102, { ppid: 101, comm: 'node' }],
			[103, { ppid: 102, comm: 'node' }],
			[200, { ppid: 1, comm: 'node' }]
		]);
		expect(findAppPid(100, table)).toBe(102);
		expect(findAppPid(200, table)).toBe(200);
		expect(findAppPid(999, table)).toBeNull();
	});
	it('reads the live process table', () => {
		const table = processTable();
		expect(table.get(process.pid)?.comm).toBe('node');
	});
});
