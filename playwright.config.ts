import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright smoke tests for DocWriter. Boots the Vite dev server, runs a
 * single chromium browser through the end-to-end flows we keep breaking.
 * Safe to run locally (`npm run test`) or in CI.
 *
 * The tests do NOT call the real Claude Agent SDK — that's too slow and
 * flaky for a smoke suite. Instead they exercise the UI up to the submit
 * boundary and the data-plane that doesn't depend on the agent (tabs,
 * autosave, review state, persistence, per-tab isolation).
 */
export default defineConfig({
	testDir: 'tests',
	testMatch: '**/*.spec.ts',
	// Tests use unique tab names per worker (random SUFFIX in each file)
	// so they don't collide in the shared `notes/` folder. Each worker
	// gets its own browser context and IndexedDB automatically.
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	// Each worker spawns its own isolated Vite. 3 hits a sweet spot — more
	// than that and the parallel cold boots start tripping the fixture
	// timeout on machines without spare cores.
	workers: process.env.CI ? 2 : 3,
	// Per-test timeout. The first test in each worker pays a ~10–15s cold
	// Vite boot via the isolatedServer fixture, so we leave headroom; later
	// tests in the same worker run inside the original ~15s budget.
	timeout: 60_000,
	expect: { timeout: 5_000 },
	reporter: process.env.CI ? 'github' : 'list',
	use: {
		baseURL: 'http://localhost:5173',
		trace: 'on-first-retry',
		screenshot: 'only-on-failure',
		// Wider than the Playwright default so the AgentDock (absolute-
		// positioned in the center pane's top-right) doesn't overlap the
		// tab bar's `+` button and intercept its clicks.
		viewport: { width: 1600, height: 900 }
	},
	projects: [
		{
			// Use the system-installed Google Chrome instead of the bundled
			// chromium so we skip the playwright browser download (which
			// sometimes fails behind proxies / ratelimits). `channel: 'chrome'`
			// points playwright at /Applications/Google Chrome.app on macOS.
			name: 'chrome',
			use: { ...devices['Desktop Chrome'], channel: 'chrome' }
		}
	]
	// No global `webServer` — each Playwright worker spawns its own Vite
	// instance on a unique port with an isolated DOCWRITER_ROOT (see
	// tests/fixtures.ts). This lets the suite run fully parallel without
	// workers stomping on each other's notes/, .docwriter/state.json, or
	// agent/ shadows.
});
