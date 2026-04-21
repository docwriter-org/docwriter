import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
		// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
		// See https://svelte.dev/docs/kit/adapters for more information about adapters.
		//
		// precompress: false — sirv auto-tries `*.br` / `*.gz` companions for
		// every asset, and `createReadStream` on a missing companion emits an
		// async 'error' that adapter-node doesn't catch, killing the process
		// with ENOENT. This hits in practice whenever the user rebuilds while
		// a browser tab still has the previous bundle hash cached (old
		// `start.<hash>.js.br` no longer exists). DocWriter runs on localhost
		// as a CLI tool, so the compression savings don't matter; skipping
		// the precompressed variants makes the file-not-found path a clean
		// 404 instead of a process crash.
		adapter: adapter({ precompress: false })
	}
};

export default config;
