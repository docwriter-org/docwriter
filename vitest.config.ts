import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
	test: {
		include: ['src/**/*.test.ts', 'fixtures/**/*.test.ts'],
		environment: 'node',
		testTimeout: 30_000
	},
	resolve: {
		alias: {
			$lib: resolve('./src/lib')
		}
	}
});
