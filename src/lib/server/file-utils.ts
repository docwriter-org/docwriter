import { renameSync, writeFileSync } from 'fs';

export function writeJsonAtomic(path: string, value: unknown) {
	const tempPath = `${path}.tmp`;
	writeFileSync(tempPath, JSON.stringify(value, null, 2));
	renameSync(tempPath, path);
}

export function writeTextAtomic(path: string, text: string) {
	const tempPath = `${path}.tmp`;
	writeFileSync(tempPath, text);
	renameSync(tempPath, path);
}

export function writeBinaryAtomic(path: string, bytes: Uint8Array) {
	const tempPath = `${path}.tmp`;
	writeFileSync(tempPath, bytes);
	renameSync(tempPath, path);
}
