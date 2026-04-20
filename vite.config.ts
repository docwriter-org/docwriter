import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	// Expose `PUBLIC_*` env vars via `import.meta.env` in addition to Vite's
	// default `VITE_*`. Matches SvelteKit's `$env/static/public` convention
	// so the same var (e.g. `PUBLIC_DOCWRITER_WS_PORT`) is reachable through
	// either path.
	envPrefix: ['VITE_', 'PUBLIC_']
});
