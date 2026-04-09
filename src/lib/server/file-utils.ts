import { renameSync, writeFileSync } from 'fs';

export function writeJsonAtomic(path: string, value: unknown) {
	const tempPath = `${path}.tmp`;
	writeFileSync(tempPath, JSON.stringify(value, null, 2));
	renameSync(tempPath, path);
}
