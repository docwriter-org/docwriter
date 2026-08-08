import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests',
	fullyParallel: false,
	workers: 1,
	use: {
		baseURL: 'http://127.0.0.1:5320',
		headless: true
	},
	webServer: {
		command: 'DOCWRITER_ROOT=/tmp/docwriter-style-e2e DOCWRITER_WS_PORT=3320 PUBLIC_DOCWRITER_WS_PORT=3320 npm run dev -- --host 127.0.0.1 --port 5320 --strictPort',
		url: 'http://127.0.0.1:5320',
		reuseExistingServer: true,
		timeout: 120_000
	}
});
