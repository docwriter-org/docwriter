import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: { $lib: resolve(root, 'src/lib') }
	},
	test: {
		include: ['src/**/*.test.ts'],
		exclude: ['.claude/**', 'tests/**', 'node_modules/**']
	}
});
