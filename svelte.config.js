import adapterNode from '@sveltejs/adapter-node';
import adapterVercel from '@sveltejs/adapter-vercel';

const isLandingDeploy = process.env.LANDING_DEPLOY === '1';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		// Landing deploy (Vercel + docwriter.org) uses adapter-vercel and only
		// serves the prerendered /welcome route. Local CLI + npm run dev on main
		// keep adapter-node with the full editor stack.
		adapter: isLandingDeploy
			? adapterVercel()
			: adapterNode({
					// precompress: false — sirv auto-tries `*.br` / `*.gz` companions for
					// every asset, and `createReadStream` on a missing companion emits an
					// async 'error' that adapter-node doesn't catch, killing the process
					// with ENOENT. This hits in practice whenever the user rebuilds while
					// a browser tab still has the previous bundle hash cached (old
					// `start.<hash>.js.br` no longer exists). DocWriter runs on localhost
					// as a CLI tool, so the compression savings don't matter; skipping
					// the precompressed variants makes the file-not-found path a clean
					// 404 instead of a process crash.
					precompress: false
				}),
		...(isLandingDeploy
			? {
					prerender: {
						entries: ['/welcome'],
						crawl: false
					}
				}
			: {})
	}
};

export default config;
